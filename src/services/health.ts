import { getLogger } from "../core/logger.js";

const log = getLogger("health");

/**
 * 功能域（= 模块）。粒度按「用户能理解的一块能力」划分，而不是按 service 类：
 * 一个模块里的多个 service 一起加载、一起降级，闸门也只认这一级。
 *
 * `status` / `health` / `help` / `menu` 这些**诊断入口不在这里**：模块全挂了它们也得能用，
 * 否则用户没有任何办法看到出了什么事。
 */
export const MODULE_KEYS = [
  "identity",
  "audit",
  "join",
  "config",
  "notify",
  "permissions",
  "groupmessage",
  "activity",
  "sanction",
  "blacklist",
  "shortcode",
  "profile",
  "alias",
  "menu",
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  identity: "账号绑定",
  audit: "审计日志",
  join: "入群申请",
  config: "群规则",
  notify: "通知中心",
  permissions: "权限",
  groupmessage: "全量消息模式",
  activity: "活动",
  sanction: "处罚与申诉",
  blacklist: "黑名单",
  shortcode: "短码",
  profile: "个人资料",
  alias: "班级别名",
  menu: "菜单推送",
};

export interface ModuleDefinition {
  key: ModuleKey;
  /** 加载（幂等、可重试）：失败只影响这个模块与它的功能域。 */
  load: () => Promise<void>;
}

export type ModuleState = "pending" | "ready" | "degraded";

export interface ModuleStatus {
  key: ModuleKey;
  label: string;
  state: ModuleState;
  /** 降级原因（加载失败的错误信息）；`ready` 时为 `undefined`。 */
  error?: string;
  /** 最近一次失败/成功的时间。 */
  changedAt?: Date;
}

export interface LoadReport {
  /** 本次加载后处于降级状态的模块。 */
  degraded: ModuleStatus[];
  /** 从降级恢复成 ready 的模块（重试成功时用）。 */
  recovered: ModuleStatus[];
}

/**
 * 模块健康注册表：**启动不因为单个模块失败而中断**，失败的模块被标记成 `degraded`，
 * 它的功能域一律判定为不可用（**默认拒绝**：`pending` / `degraded` 都不可用）。
 *
 * 为什么不吞掉异常了事：降级必须可见 —— 调用方要拿到 `degraded` 列表去写日志、展示状态、
 * 通知超管；只 catch 不报告等于把「崩溃」换成更难发现的「静默半瘫」。
 */
export class HealthRegistry {
  private readonly modules = new Map<ModuleKey, ModuleDefinition>();
  private readonly statuses = new Map<ModuleKey, ModuleStatus>();

  public constructor(
    definitions: readonly ModuleDefinition[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  public register(definition: ModuleDefinition): void {
    if (this.modules.has(definition.key)) {
      throw new Error(`重复注册模块：${definition.key}`);
    }
    this.modules.set(definition.key, definition);
    this.statuses.set(definition.key, {
      key: definition.key,
      label: MODULE_LABELS[definition.key],
      state: "pending",
    });
  }

  /** 逐个加载；单个模块抛错只标记它自己，其余继续。 */
  public async loadAll(): Promise<LoadReport> {
    const report: LoadReport = { degraded: [], recovered: [] };
    for (const key of this.modules.keys()) {
      const previous = this.stateOf(key);
      const status = await this.loadOne(key);
      if (status.state === "degraded") {
        report.degraded.push(status);
      } else if (previous === "degraded") {
        report.recovered.push(status);
      }
    }
    return report;
  }

  /** 重试单个模块（修好数据/环境后不必重启）。 */
  public async retry(key: ModuleKey): Promise<ModuleStatus> {
    if (!this.modules.has(key)) {
      throw new Error(`未知模块：${key}`);
    }
    return this.loadOne(key);
  }

  /** 已注册的全部模块状态（含 `pending`）。 */
  public list(): ModuleStatus[] {
    return [...this.modules.keys()].map((key) => this.statusOf(key));
  }

  public statusOf(key: ModuleKey): ModuleStatus {
    const status = this.statuses.get(key);
    if (!status) {
      throw new Error(`未知模块：${key}`);
    }
    return { ...status };
  }

  public get degraded(): ModuleStatus[] {
    return this.list().filter((status) => status.state === "degraded");
  }

  /**
   * 模块是否可用。
   *
   * 只有**明确失败过**（`degraded`）才判不可用：`pending` 不算 —— 内存模式下根本不会调
   * `load()`（服务本来就是内存态、可用），而正式启动时 `load()` 在网关接上之前就跑完了，
   * 不存在「命令先到、模块还没加载」的窗口。
   */
  public isAvailable(key: ModuleKey): boolean {
    return this.stateOf(key) !== "degraded";
  }

  /** 该功能域是否可用；`keys` 里任一模块不可用即不可用。 */
  public isAllAvailable(keys: readonly ModuleKey[]): boolean {
    return keys.every((key) => this.isAvailable(key));
  }

  /** 不可用的原因（卡片文案直接用）。 */
  public reasonOf(key: ModuleKey): string | undefined {
    const status = this.statusOf(key);
    if (status.state === "ready") {
      return undefined;
    }
    return status.state === "degraded"
      ? `「${status.label}」初始化失败：${status.error ?? "未知错误"}`
      : `「${status.label}」还没有完成初始化`;
  }

  private stateOf(key: ModuleKey): ModuleState {
    return this.statuses.get(key)?.state ?? "pending";
  }

  private async loadOne(key: ModuleKey): Promise<ModuleStatus> {
    const definition = this.modules.get(key);
    if (!definition) {
      throw new Error(`未知模块：${key}`);
    }
    try {
      await definition.load();
      return this.setState(key, { state: "ready" });
    } catch (error) {
      const status = this.setState(key, {
        state: "degraded",
        error: describeError(error),
      });
      log.error("module degraded", { module: key, error: status.error });
      return status;
    }
  }

  private setState(
    key: ModuleKey,
    patch: { state: ModuleState; error?: string },
  ): ModuleStatus {
    const previous = this.statuses.get(key);
    const status: ModuleStatus = {
      key,
      label: previous?.label ?? MODULE_LABELS[key],
      state: patch.state,
      changedAt: this.now(),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    };
    this.statuses.set(key, status);
    return { ...status };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
