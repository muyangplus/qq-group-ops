import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  BUILD_INFO_FILE,
  readBuildInfo,
  verifyBuildInfo,
  type BuildInfo,
} from "../core/buildInfo.js";
import { getLogger } from "../core/logger.js";
import { valueOf, type Provider } from "../core/provider.js";
import { formatDisplayTime } from "../core/timeFormat.js";
import type { DeployControl, DeployPending } from "./deployWatcher.js";
import {
  removeSyncStateFiles,
} from "./distSnapshot.js";

const log = getLogger("deploy-installer");

/** CD 的「投递箱」：与 `dist/` 同级；机器人扫它、解包、自证、替换。 */
export const INCOMING_DIR = "incoming";

/** 归档目录：**应用成功的包同时当备份**（回滚 = 重新应用上一个包）。 */
export const PACKAGE_ARCHIVE_DIR = "data/packages";

/** 解包工作目录（`data/incoming/<版本>/`；`data/` 永远不进替换面）。 */
export const PACKAGE_UNPACK_DIR = "data/incoming";

/** 部署状态文件（`{appliedVersion, appliedSha, previousVersion, previousSha}`）。 */
export const DEPLOY_STATE_FILE = "data/deploy-state.json";

/** 回执文件（人可读的最近一次部署结果；运维 SOP 直接 `cat` 它）。 */
export const DEPLOY_RECEIPT_FILE = "data/deploy-receipt.json";

/**
 * `incoming/` 与 `data/packages/` 各只保留最近 3 个包（ADR-0065 的能力边界）。
 *
 * 按「最近落地」排序而不是版本号排序：磁盘上的版本号排序对多段版本号（0.10 vs 0.9）
 * 并不直观，而这两个目录本来就是「最近几次上传」的队列。
 */
export const PACKAGE_KEEP = 3;

/**
 * 会被整目录（整文件）替换的运行产物。
 *
 * **只动这三项**：`data/`、`.env`、`logs/` 绝不碰（ADR-0065 的能力边界）；
 * 依赖清单与 `.env.example` 只作为参考随包刷新，不是「替换面」。
 */
export const DEPLOY_TARGETS: readonly string[] = ["dist", "web/dist", "scripts"];

/** 随包刷新、但不在替换面里的参考文件（存在才动，不新增也不删除）。 */
export const DEPLOY_REFERENCE_FILES: readonly string[] = [
  "pnpm-lock.yaml",
  ".env.example",
];

/** CD 第二段落地的「传完了」标记（ADR-0065 与 ADR-0057 同构）。 */
export interface DeployPackage {
  version: string;
  /** 构建来源 commit。 */
  commit: string;
  /** `.tgz` 的 sha256（防半传）。 */
  sha256: string;
  /** 构建期算好的 `dist/` 指纹（与包内 `build-info.json` 一致）。 */
  distFingerprint: string;
  /** 构建时刻（ISO）。 */
  builtAt: string;
}

/** `data/deploy-state.json`：当前生效的版本 + 上一个版本（回滚目标）。 */
export interface DeployState {
  appliedVersion: string;
  appliedSha: string;
  previousVersion: string;
  previousSha: string;
}

/** 回滚目标（`/status proc` 卡片与后台「状态」页显示）。 */
export interface RollbackTarget {
  /** 要回滚到的版本（`deploy-state.json` 的 `previousVersion`）。 */
  version: string;
  /** 当前运行 / 生效的版本。 */
  currentVersion: string;
  /** 上一个包的 sha256（回执与审计里的凭证）。 */
  sha256: string;
}

/** 失败原因（回执与私信都用它区分「怎么失败的」）。 */
export type InstallErrorCode =
  | "no_package"
  | "no_target"
  | "version_mismatch"
  | "sha_mismatch"
  | "unpack_failed"
  | "self_check_failed"
  | "replace_failed"
  | "restart_rejected"
  | "read_failed";

export interface InstallResult {
  ok: boolean;
  /** 这次动作的目标版本。 */
  version: string;
  code: InstallErrorCode | "ok";
  /** 人话说明（回执 / 私信 / HTTP 回执都用它）。 */
  message: string;
  /** 归档后的包路径（成功时）。 */
  bundle?: string | undefined;
  /** 这次安装是不是一次「回滚」（`vX → vY` 里的方向）。 */
  rolledBack?: boolean | undefined;
  /** 失败且**已经自动还原上一个包**时带上（`replace_failed` 的回执用）。 */
  restoredVersion?: string | undefined;
}

/**
 * 安装器的**控制面**（命令层与后台「状态」页只依赖这个窄接口）。
 *
 * 与 `DeployControl` 分开：那是「部署监测」（发现新版本 / 取消 / 立即重启），
 * 这是「安装器」（回滚到上一个包）。两者都是运维入口，但判据与状态完全不同。
 */
export interface InstallerControl {
  /** 回滚到上一个包（重新应用 `data/packages/` 里的那份）。 */
  rollback(): Promise<InstallResult>;
  /** 可回滚的目标；没得回滚时 `undefined`（界面据此隐藏按钮）。 */
  rollbackTarget(): RollbackTarget | undefined;
  /** 当前生效的版本（没接过状态文件时为空串）。 */
  appliedVersion(): string;
}

export interface DeployInstallerOptions {
  /** CD 投递箱；缺省 `incoming`。 */
  incomingDir?: string;
  /** 归档目录；缺省 `data/packages`。 */
  archiveDir?: string;
  /** 解包目录；缺省 `data/incoming`。 */
  workDir?: string;
  /** 状态文件；缺省 `data/deploy-state.json`。 */
  stateFile?: string;
  /** 回执文件；缺省 `data/deploy-receipt.json`。 */
  installerReceiptFile?: string;
  /**
   * **应用根目录（替换面相对它解析）—— 必填，没有缺省。**
   *
   * ⚠️ 真机事故（2026-10-12，0.30.0 发布）：这里原本是可选、缺省「状态文件的上一级」，
   * 而 `stateFile` 缺省是 `data/deploy-state.json` ⇒ 生产装配忘了传时 `root` 变成 **`data`**，
   * 于是整目录替换做在 `data/dist`、`data/web/dist`、`data/scripts` 上，**live 产物一个字节没动**，
   * 却照样写 `applied=0.30.0` + 回执 + 「deployment applied」日志（三道自检都读到旧 dist，
   * 全都「通过」——直到 `/status proc` 里「运行 0.29.1 vs 记账 0.30.0」露馅）。
   * 改成必填：**谁都得显式说清「要替换的是哪个根」**（生产是 `process.cwd()`，
   * 单测是临时目录），tsc 会替我们守住这件事。
   */
  deployRoot: string;
  /** 交接给既有重启用例（`src/services/restart.ts` 的 `RestartHook`）。 */
  restart: (info: { requestedBy: string; reason: "deploy"; targetVersion: string }) => boolean;
  /** 私信投递（半传 / 自证失败 / 替换失败都私信超管）。 */
  notify: (userId: string, card: InstallNotice) => Promise<void>;
  /** 收件人（全部全局超管）。 */
  recipients: () => readonly string[];
  /**
   * 宽限期（毫秒）：包**校验通过**后先提醒超管，等这么久再自动应用 + 重启。
   *
   * - **不传 = 没有宽限期**（校验通过就直接应用）：单测与嵌入式用法走这条，行为与
   *   「到了就应用」的老实现一致；
   * - 传 `0` = 「先提醒、当轮就应用」（与逐文件模式的 `DEPLOY_RESTART_DELAY_MINUTES=0` 一致）；
   * - 生产装配（`main.ts`）传 `deployRestartDelayMinutes`，默认 10 分钟。
   *
   * 热配置：用的时候取当前值（`/config` 改完立即生效）。
   */
  graceMs?: Provider<number>;
  /**
   * 到点要不要自己动手应用 + 重启（`AUTO_RESTART_ON_DEPLOY`）；缺省 `true`。
   *
   * 关着时**照样提醒**，只是到点不动手：包一直留在 `incoming/` 里等着（已校验通过、不用重新上传），
   * 用户打开开关后，下一轮扫描按原计划应用 —— 与逐文件模式同一套语义。
   */
  autoApply?: Provider<boolean>;
  /** 当前运行版本（卡片与 `pending()` 里的「当前运行」）；缺省空串。 */
  runningVersion?: () => string;
  /** 时钟（回执与 `*.failed-<ts>` 的时间戳）；缺省 `Date.now`。 */
  clock?: () => number;
  /** 回执里写的发起人；缺省 `deploy-installer`。 */
  actor?: string;
}

/** 「新版本已就绪，等宽限期」通知里给卡片用的附加信息（按钮由 `main.ts` 渲染）。 */
export interface InstallNoticePending {
  /** 计划自动应用 + 重启的时刻（ISO）。 */
  deadlineAt: string;
  /** 到点会不会自己动手（`AUTO_RESTART_ON_DEPLOY`）。 */
  autoApply: boolean;
  /** 当前运行版本。 */
  currentVersion: string;
  /** 产物包 sha256（卡片上只写前 12 位，运维对账用）。 */
  sha256: string;
}

/**
 * 安装结果通知卡的最小内容（避免服务层依赖卡片模板；`main.ts` 负责渲染）。
 *
 * 类型上只要求标题 + 正文行，投递侧自己 `renderCard`。
 */
export interface InstallNotice {
  title: string;
  lines: string[];
  kind:
    | "half-transferred"
    | "self-check-failed"
    | "replace-failed"
    | "rollback"
    | "new-version";
  version: string;
  /** 只有 `new-version` 带：卡片据此渲染「取消自动应用 / 立即应用并重启」两个按钮。 */
  pending?: InstallNoticePending | undefined;
}

/**
 * 机器人自解产物包（ADR-0065 第 2、3 条）。
 *
 * 流程（**每一步失败都不动现役 `dist/`**）：
 * 1. 扫 `incoming/deploy-*.json`（**最后落地的那个标记文件**，见 ADR-0057 的同构做法）；
 * 2. **sha256 校验 `.tgz`**（不符 = 半传：忽略 + 私信，**同一份失败的包不反复重试刷屏**）；
 * 3. 解到 `data/incoming/<版本>/`；
 * 4. 用 `distFingerprint()` 与包内 `build-info.json` **自证**（对不上 = 半传 / 混装 / 坏包）；
 * 5. **先提醒超管**（「发现新版本 + 计划何时自动应用」，见 `graceMs`）——这一步是 ADR-0065
 *    后续修正：与逐文件模式（`DeployWatcher`）对齐，**不再「到了就应用」**；
 * 6. 宽限期到点（且 `AUTO_RESTART_ON_DEPLOY` 开着）→ **整目录替换** `dist` / `web/dist` /
 *    `scripts`（替换前旧目录改名 `.prev`；失败逐个还原）；
 * 7. 交给既有重启用例（`RestartHook.request(reason="deploy")`）；
 * 8. 成功：写回执 + `data/deploy-state.json`（含 `previous*`，供回滚）+ 归档到
 *    `data/packages/`（只留最近 3 个）+ 删掉 `incoming/` 里这份包 + 清干净 `.prev`。
 *
 * 宽限期里「取消」= **放弃这份投递**：产物一个字节都不动，两个文件改名 `*.cancelled-<ts>`
 * 留证（所以既不会自己生效，也不会在下次重启进程后又冒出来）。
 *
 * **回滚** = 重新应用 `data/packages/` 里的上一个包（同一安装器、同一套指纹自证），
 * 不需要 tar/gzip 的写侧能力（只用只读解析）。
 */
/** 校验通过、等宽限期的包（宽限期到点才替换产物）。 */
interface PreparedPackage {
  version: string;
  archive: string;
  meta: DeployPackage;
  unpackDir: string;
  rolledBack: boolean;
  /** 成功后才删除的投递箱文件（回滚时为空）。 */
  removeFiles: readonly string[];
}

/** 等宽限期中的投递（`detectedAt` / `deadlineAt` 只在这一层有意义）。 */
interface WaitingPackage {
  prepared: PreparedPackage;
  detectedAt: string;
  deadlineAt: string;
}

export class DeployInstaller implements DeployControl {
  private readonly incomingDir: string;
  private readonly archiveDir: string;
  private readonly workDir: string;
  private readonly stateFile: string;
  private readonly receiptFile: string;
  private readonly root: string;
  private readonly restart: DeployInstallerOptions["restart"];
  private readonly notify: DeployInstallerOptions["notify"];
  private readonly recipients: () => readonly string[];
  private readonly clock: () => number;
  private readonly actor: string;
  private readonly graceMs: Provider<number> | undefined;
  private readonly autoApply: Provider<boolean>;
  private readonly runningVersion: () => string;
  /** 已校验通过、正在等宽限期的投递；`undefined` = 没有等待中的应用。 */
  private waiting: WaitingPackage | undefined;
  /** 已经私信过的失败包（`<版本>:<sha256 前 12 位>:<原因>`），避免反复刷屏。 */
  private readonly reported = new Set<string>();

  public constructor(options: DeployInstallerOptions) {
    this.stateFile = options.stateFile ?? DEPLOY_STATE_FILE;
    // 必填（见 `DeployInstallerOptions.deployRoot` 的事故说明）：不再从 `stateFile` 猜。
    this.root = options.deployRoot;
    this.incomingDir = options.incomingDir ?? INCOMING_DIR;
    this.archiveDir = options.archiveDir ?? PACKAGE_ARCHIVE_DIR;
    this.workDir = options.workDir ?? PACKAGE_UNPACK_DIR;
    this.receiptFile = options.installerReceiptFile ?? DEPLOY_RECEIPT_FILE;
    this.restart = options.restart;
    this.notify = options.notify;
    this.recipients = options.recipients;
    this.clock = options.clock ?? Date.now;
    this.actor = options.actor ?? "deploy-installer";
    this.graceMs = options.graceMs;
    this.autoApply = options.autoApply ?? (() => true);
    this.runningVersion = options.runningVersion ?? (() => "");
  }

  /** 当前状态（`applied*` / `previous*`）；没有状态文件时 `undefined`。 */
  public state(): DeployState | undefined {
    return readDeployState(this.stateFile);
  }

  /** 可回滚的目标（上一个包）；没得回滚时 `undefined`。 */
  public rollbackTarget(): RollbackTarget | undefined {
    const state = this.state();
    if (!state || state.previousVersion.length === 0) {
      return undefined;
    }
    const archive = findArchivedBundle(this.archiveDir, state.previousVersion);
    if (!archive) {
      return undefined;
    }
    return {
      version: state.previousVersion,
      currentVersion: state.appliedVersion || state.previousVersion,
      sha256: state.previousSha,
    };
  }

  /**
   * 扫一轮投递箱（由统一扫描周期 `TickScheduler` 驱动，与部署监测同一条节拍）。
   *
   * 两条路径：
   * - 上一轮已经**校验通过并提醒过**的投递（等宽限期）→ 到点（且 `AUTO_RESTART_ON_DEPLOY`
   *   开着）才应用；关着就一直等（用户打开开关后，下一轮按原计划继续）；
   * - 否则扫 `incoming/`：校验通过的那份**先提醒**，校验不过的照旧拒绝 + 改名留证。
   *
   * 一次只处理**一个**包：宽限期一过替换 `dist/`，本进程即将被重启，继续处理下一个没有意义
   * （新进程起来后会接着扫）。
   */
  public async runOnce(): Promise<InstallResult | undefined> {
    const waiting = this.waiting;
    if (waiting) {
      // `AUTO_RESTART_ON_DEPLOY` 关着时**不应用、也不清状态**：用户之后把开关打开，
      // 下一轮扫描就按原计划继续（与逐文件模式同一套语义）。
      if (!valueOf(this.autoApply) || this.clock() < Date.parse(waiting.deadlineAt)) {
        return undefined;
      }
      this.waiting = undefined;
      return this.commitPrepared(waiting.prepared);
    }

    const pending = listPending(this.incomingDir);
    for (const item of pending) {
      const meta = readPackageMeta(item.jsonPath);
      if (!meta) {
        // 坏标记（JSON 坏了 / 缺 version·sha256）：改名留证 + 私信一次，**不静默**
        await this.reportFailure(
          "read_failed",
          { version: basename(item.jsonPath), commit: "", sha256: "unknown", distFingerprint: "", builtAt: "" },
          `${basename(item.jsonPath)} 读不出（坏 JSON 或缺少 version / sha256）`,
        );
        markFailed(item.jsonPath, this.clock(), this.reported, "read_failed", "");
        continue;
      }
      const archive = join(this.incomingDir, `deploy-${meta.version}.tgz`);
      if (!existsSync(archive)) {
        // 只有「传完了」标记、包本身还没落地：**留着等下一轮**（半传的正常中间态，不刷屏）
        log.warn("deploy package marker without archive, waiting", {
          version: meta.version,
          archive,
        });
        continue;
      }
      const prepared = await this.prepare({
        version: meta.version,
        archive,
        meta,
        rolledBack: false,
        removeFiles: [archive, item.jsonPath],
      });
      if (!prepared.ok) {
        return prepared.result;
      }
      // 没配宽限期（单测 / 嵌入式用法）：校验通过就直接应用 —— 与老实现完全一致。
      if (this.graceMs === undefined) {
        return this.commitPrepared(prepared.value);
      }
      const grace = Math.max(0, valueOf(this.graceMs));
      const now = this.clock();
      const armed: WaitingPackage = {
        prepared: prepared.value,
        detectedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + grace).toISOString(),
      };
      this.waiting = armed;
      log.info("deploy package ready, waiting for the grace period", {
        version: meta.version,
        graceMinutes: Math.round(grace / 60_000),
        deadlineAt: armed.deadlineAt,
        autoApply: valueOf(this.autoApply),
        // 与部署监测一样带上 pid：区分「同一进程重复提醒」与「两个进程各提醒一次」。
        pid: process.pid,
      });
      await this.notifyNewVersion(armed);
      // 宽限期 0 且开着自动应用 → 这一轮就动手（与逐文件模式 `deployRestartDelayMinutes=0` 一致）
      if (grace <= 0 && valueOf(this.autoApply)) {
        this.waiting = undefined;
        return this.commitPrepared(armed.prepared);
      }
      return undefined;
    }
    return undefined;
  }

  /** 待应用的投递（供 `/deploy cancel`、`/deploy now`、管理 API 的「状态」页）。 */
  public pending(): DeployPending | undefined {
    const waiting = this.waiting;
    if (!waiting) {
      return undefined;
    }
    return {
      targetVersion: waiting.prepared.version,
      currentVersion: this.runningVersion(),
      detectedAt: waiting.detectedAt,
      deadlineAt: waiting.deadlineAt,
      mode: "package",
    };
  }

  /**
   * 取消这次自动应用（`/deploy cancel` 与卡片按钮）。
   *
   * **语义 = 放弃这份投递**：产物一个字节都不动，`incoming/` 里那两个文件改名
   * `*.cancelled-<ts>` 留证 —— 所以它不会「下次重启进程后又自己冒出来应用」，想上线就重新发布一次
   * （或按 OPERATIONS.md 手工把改名后的包放回去再写一份标记）。
   */
  public cancel(): boolean {
    const waiting = this.waiting;
    if (!waiting) {
      return false;
    }
    this.waiting = undefined;
    this.renameCancelledPair(waiting.prepared);
    log.info("deploy package auto-apply cancelled", {
      version: waiting.prepared.version,
    });
    return true;
  }

  /**
   * 立即应用并重启（不等宽限期）。
   *
   * 时序与部署监测一致：替换产物与受理重启用例都是**同步**的（只有写回执是 async），
   * 所以调用方渲染「正在重启」卡片时，重启已经安排上了。
   */
  public restartNow(): boolean {
    const waiting = this.waiting;
    if (!waiting) {
      return false;
    }
    this.waiting = undefined;
    void this.commitPrepared(waiting.prepared).catch((error: unknown) => {
      log.error("deploy package apply failed after manual trigger", {
        version: waiting.prepared.version,
        error: describeError(error),
      });
    });
    return true;
  }

  /**
   * 回滚：重新应用归档里的上一个包（同一安装器、同一套指纹自证）。
   *
   * `data/packages/` 里的包是**已经应用成功过**的那份，所以不再做 sha256 校验
   * （那是防「FTP 半传」的判据，归档是本地产物）；指纹自证照做 —— 那是防「包坏了 / 混装」。
   */
  public async rollback(): Promise<InstallResult> {
    // 回滚是「明确不要这次投递」：把等宽限期的那个包一并放弃（改名留证）——
    // 否则宽限期一到，它会把刚回滚下去的版本又顶上来。
    if (this.waiting) {
      log.warn("pending deploy package dropped by rollback", {
        version: this.waiting.prepared.version,
      });
      this.renameCancelledPair(this.waiting.prepared);
      this.waiting = undefined;
    }
    const state = this.state();
    if (!state || state.previousVersion.length === 0) {
      return {
        ok: false,
        version: "",
        code: "no_target",
        message: "没有可回滚的上一个版本（data/deploy-state.json 里没有 previousVersion）。",
      };
    }
    const archive = findArchivedBundle(this.archiveDir, state.previousVersion);
    if (!archive) {
      return {
        ok: false,
        version: state.previousVersion,
        code: "no_package",
        message: `归档里找不到 v${state.previousVersion} 的包（data/packages/ 只保留最近 ${PACKAGE_KEEP} 个）。`,
      };
    }
    const buildInfo = readArchivedBuildInfo(archive, this.unpackTmpDir());
    if (!buildInfo?.distFingerprint) {
      return {
        ok: false,
        version: state.previousVersion,
        code: "self_check_failed",
        message: `归档包 v${state.previousVersion} 读不到 build-info.json 的 distFingerprint，拒绝回滚。`,
      };
    }
    const prepared = await this.prepare({
      version: state.previousVersion,
      archive,
      meta: {
        version: state.previousVersion,
        commit: buildInfo.commit,
        sha256: state.previousSha,
        distFingerprint: buildInfo.distFingerprint,
        builtAt: buildInfo.builtAt,
      },
      rolledBack: true,
      removeFiles: [],
    });
    if (!prepared.ok) {
      return prepared.result;
    }
    return this.commitPrepared(prepared.value);
  }

  // ------------------------------------------------------------------ 安装

  /**
   * 失败收口：私信（去重）+ 坏包改名留证 + 写回执。
   *
   * `prepare` 与 `commitPrepared` 共用 —— 两个阶段的失败都要留下同样的证据。
   */
  private failFactory(
    meta: DeployPackage,
    archive: string,
    version: string,
    rolledBack: boolean,
  ): (
    code: InstallErrorCode,
    message: string,
    options?: { report?: boolean },
  ) => Promise<InstallResult> {
    return async (code, message, options = {}) => {
      const report = options.report ?? true;
      if (report) {
        await this.reportFailure(code, meta, message);
      }
      if (!rolledBack) {
        renameFailedPackage(archive, this.clock(), this.reported, this.logDedupe(meta, code));
      }
      await writeReceipt(this.receiptFile, {
        at: new Date(this.clock()).toISOString(),
        actor: this.actor,
        ok: false,
        code,
        version,
        message,
      });
      return { ok: false, version, code, message, ...(rolledBack ? { rolledBack: true } : {}) };
    };
  }

  /**
   * 校验：sha256 → 解到 `data/incoming/<版本>/` → 指纹自证 —— **这一步一个字节都不动现役产物**。
   *
   * 单独拆出来是因为 ADR-0065 的后续修正：校验通过之后要**先提醒、等宽限期**，到点才替换
   * （对齐逐文件模式）。失败时直接返回「当成结果」的 `InstallResult`（已经私信 + 留证 + 写回执）。
   */
  private async prepare(input: {
    version: string;
    archive: string;
    meta: DeployPackage;
    rolledBack: boolean;
    /** 成功后才删除的投递箱文件（回滚时为空）。 */
    removeFiles: readonly string[];
  }): Promise<
    { ok: true; value: PreparedPackage } | { ok: false; result: InstallResult }
  > {
    const { version, archive, meta, rolledBack, removeFiles } = input;
    const fail = this.failFactory(meta, archive, version, rolledBack);

    // ① sha256：防半传（只对投递箱里的包做；归档包是本地产物，见 rollback() 的说明）
    if (!rolledBack) {
      const actual = sha256OfFile(archive);
      if (actual === undefined) {
        return { ok: false, result: await fail("read_failed", `读不到 ${basename(archive)}`) };
      }
      const expected = meta.sha256.trim().toLowerCase();
      if (expected.length > 0 && actual !== expected) {
        return {
          ok: false,
          result: await fail(
            "sha_mismatch",
            `sha256 不符（半传可能）：标记 ${expected}，实际 ${actual}`,
          ),
        };
      }
    }

    // ② 解开到 data/incoming/<版本>/
    const unpackDir = this.unpackDir(version);
    try {
      rmSync(unpackDir, { recursive: true, force: true });
      mkdirSync(unpackDir, { recursive: true });
      extractTarGz(readFileSync(archive), unpackDir);
    } catch (error) {
      const detail = describeError(error);
      rmSync(unpackDir, { recursive: true, force: true });
      return { ok: false, result: await fail("unpack_failed", `解包失败：${detail}`) };
    }

    // ③ 自证：版本号 + dist 指纹（与包内 build-info.json 对）
    const buildInfo = readBuildInfo(join(unpackDir, "dist"));
    if (!buildInfo || buildInfo.version !== version) {
      return {
        ok: false,
        result: await fail(
          "version_mismatch",
          `包内 build-info.json 的版本是 ${buildInfo?.version ?? "（读不到）"}，标记是 ${version}`,
        ),
      };
    }
    const check = verifyBuildInfo(join(unpackDir, "dist"));
    if (!check.ok) {
      return {
        ok: false,
        result: await fail("self_check_failed", `dist 自证不过：${check.detail}`),
      };
    }
    if (meta.distFingerprint.length > 0 && buildInfo.distFingerprint !== meta.distFingerprint) {
      return {
        ok: false,
        result: await fail(
          "self_check_failed",
          `包内指纹（${buildInfo.distFingerprint ?? "无"}）与投递标记（${meta.distFingerprint}）不一致`,
        ),
      };
    }

    return { ok: true, value: { version, archive, meta, unpackDir, rolledBack, removeFiles } };
  }

  /** 替换产物 + 交接重启 + 归档/状态/回执（**只对已经校验通过的包调用**）。 */
  private async commitPrepared(prepared: PreparedPackage): Promise<InstallResult> {
    const { version, archive, meta, unpackDir, rolledBack, removeFiles } = prepared;
    const fail = this.failFactory(meta, archive, version, rolledBack);

    // 宽限期里 CD 可能把同一个包**重传**了一遍（字节变了）：产物内容在 `prepare` 里已经校验过
    // （替换用的是那份解出来的产物，不再读 `.tgz`），这里只提醒一句 —— 归档到
    // `data/packages/` 的会是磁盘上现在那份字节。
    if (!rolledBack && meta.sha256.length > 0) {
      const current = sha256OfFile(archive);
      if (current !== undefined && current !== meta.sha256.trim().toLowerCase()) {
        log.warn("deploy package changed during the grace period, archiving on-disk bytes", {
          version,
          verified: meta.sha256.slice(0, 12),
          onDisk: current.slice(0, 12),
        });
      }
    }

    // ④ 整目录替换。`swapTargets` 内部保证「要么全换、要么全不换」：任何一个 target 失败，
    //    已经换掉的那几个会立刻从 `.prev-<pid>` 换回来。所以这里**不需要**再叠一层
    //    「从上一个包整树还原」—— 那反而会在同一个失败面上（例如 root/web 被占住）再失败一次，
    //    把 `.restore-*` 残骸留在 workDir 里。要还原的是「换了之后起不来」那条路（见 restart 失败）。
    const previous = this.state();
    try {
      swapTargets(this.root, unpackDir);
    } catch (error) {
      return fail("replace_failed", `替换产物目录失败（已整体回退，现役产物未变）：${describeError(error)}`);
    }

    // ④′ **对着现役产物再自证一次**（不是对着解包目录）：换完之后的 `dist/` 必须真的就是这一份包。
    // 挡的是「换到了别的地方 / 只换了一半 / 换完被改过」——ADR-0073 的真机事故（root 算成 `data/`，
    // live 产物一个字节没动却报「已应用」）正是少了这一道；有了它，报成功之前必须先证明
    // 「现役产物 == 这份包」。
    const liveCheck = verifyBuildInfo(join(this.root, "dist"));
    if (!liveCheck.ok) {
      const restored = await this.restorePrevious(previous);
      const result = await fail(
        "replace_failed",
        `替换后现役 dist 自证不过（${liveCheck.detail}）：已把产物还原成上一个包，继续跑旧版本。`,
      );
      return {
        ...result,
        ...(restored !== undefined ? { restoredVersion: restored } : {}),
      };
    }

    // ⑤ 交接给既有重启用例
    const accepted = this.restart({
      requestedBy: this.actor,
      reason: "deploy",
      targetVersion: version,
    });
    if (!accepted) {
      const restored = await this.restorePrevious(previous);
      return fail(
        "restart_rejected",
        "重启未被受理（重启钩子没装配或助手起不来）：已把产物还原成上一个包，继续跑旧版本。",
      ).then((result) => ({
        ...result,
        ...(restored !== undefined ? { restoredVersion: restored } : {}),
      }));
    }

    // ⑥ 成功：归档 → 状态 → 回执 → 清理
    const archived = archiveBundle(archive, meta, this.archiveDir);
    // `previous*` 一律记「这次换下去的那份」：正向部署与回滚都是同一个语义
    //（回滚之后再点一次回滚就回到原处，不需要额外状态）。
    const applied: DeployState = {
      appliedVersion: version,
      appliedSha: meta.sha256,
      previousVersion: previous?.appliedVersion ?? "",
      previousSha: previous?.appliedSha ?? "",
    };
    writeDeployState(this.stateFile, applied);
    for (const file of removeFiles) {
      rmSync(file, { force: true });
    }
    trimArchive(this.archiveDir);
    trimIncoming(this.incomingDir);
    // 自己动过 dist/ 了 → 主动作废 FTP 同步状态：下一轮 CD 必须全量（ADR-0065 第 5 条）
    const removedState = removeSyncStateFiles(this.root);
    await writeReceipt(this.receiptFile, {
      at: new Date(this.clock()).toISOString(),
      actor: this.actor,
      ok: true,
      code: "ok",
      version,
      message: rolledBack
        ? `已回滚到 v${version}（原 v${previous?.appliedVersion ?? "unknown"}）。`
        : `已应用 v${version}，交给重启流程加载。`,
      ...(rolledBack && previous
        ? { fromVersion: previous.appliedVersion }
        : {}),
    });
    log.warn(rolledBack ? "rollback applied" : "deployment applied", {
      version,
      from: previous?.appliedVersion ?? "",
      archive: archived,
      syncStateRemoved: removedState,
    });
    return {
      ok: true,
      version,
      code: "ok",
      message: rolledBack
        ? `已回滚到 v${version}（v${previous?.appliedVersion ?? "?"} → v${version}），重启后生效。`
        : `已应用 v${version}，重启后生效。`,
      ...(archived !== undefined ? { bundle: archived } : {}),
      ...(rolledBack ? { rolledBack: true } : {}),
    };
  }

  /**
   * 放弃一份投递：两个文件（`.tgz` 与标记 `.json`）都改名 `*.cancelled-<ts>` 留证。
   *
   * 为什么不直接删：与 `*.failed-<ts>` 一样，现场要留着查（也可能有人想手工放回去应用）。
   * 改名之后 `listPending()`（只认 `deploy-*.json`）与 `trimIncoming()`（只认 `*.tgz`）
   * 都不会再认它 —— 所以它既不会自己生效，也不会被清理策略顺手删掉。
   */
  private renameCancelledPair(prepared: PreparedPackage): void {
    const at = this.clock();
    const files =
      prepared.removeFiles.length > 0 ? prepared.removeFiles : [prepared.archive];
    for (const file of files) {
      try {
        renameSync(file, `${file}.cancelled-${at}`);
      } catch (error) {
        log.warn("cancelled delivery rename skipped", { file, error: describeError(error) });
      }
    }
  }

  /**
   * 「发现新版本」卡：**先提醒再应用**（ADR-0065 的后续修正，与逐文件模式对齐）。
   *
   * 两种文案：开着自动重启 → 写清什么时候应用；关着 → 写清「到点不会动手」以及怎么手动上线。
   * 按钮由 `main.ts` 渲染（`InstallNotice.pending`），回调走 `cb:deploy:cancel` / `cb:deploy:now`
   * —— 与逐文件模式**共用同一对回调**，所以命令层不用分叉。
   */
  private async notifyNewVersion(armed: WaitingPackage): Promise<void> {
    const { prepared, deadlineAt } = armed;
    const version = prepared.version;
    const current = this.runningVersion();
    const currentText = current.length > 0 ? current : "unknown";
    const sha = prepared.meta.sha256.slice(0, 12);
    const autoApply = valueOf(this.autoApply);
    const lines = autoApply
      ? [
          `**产物包**：v${version}（已校验通过：sha256 ${sha}）`,
          `**当前运行**：v${currentText}`,
          `**自动应用并重启**：${formatDisplayTime(new Date(deadlineAt))}`,
          "",
          "到点会自动应用并重启加载新版本（重启期间约几秒不可用），完成后会私信你一条回执。",
          "想改期就点「取消自动应用」（这份投递会被放弃，不会自己再应用），想马上生效就点「立即应用并重启」。",
        ]
      : [
          `**产物包**：v${version}（已校验通过：sha256 ${sha}）`,
          `**当前运行**：v${currentText}`,
          "**自动重启已关闭**：到点**不会**自动应用 —— 请手动点「立即应用并重启」加载新版本，",
          "或把 `autoRestartOnDeploy` 打开（下一轮扫描会自动应用并重启）。",
          "",
          "产物包会一直留在 `incoming/` 里等着，**不需要重新发布**。",
          "想先不动就点「取消自动应用」（这份投递会被放弃，重新发布才会再提醒）。",
        ];
    const notice: InstallNotice = {
      title: "发现新版本",
      lines,
      kind: "new-version",
      version,
      pending: {
        deadlineAt,
        autoApply,
        currentVersion: current,
        sha256: prepared.meta.sha256,
      },
    };
    for (const userId of this.recipients()) {
      try {
        await this.notify(userId, notice);
      } catch (error) {
        log.warn("deploy new-version notice not delivered", {
          userId,
          version,
          error: describeError(error),
        });
      }
    }
  }

  /**
   * 「装上了但没能重启」时，把现役产物还原成上一个成功应用过的包（**整树**，走同一套自证）。
   *
   * 这是必要的第二道保险：`swapTargets` 只能保证「替换过程本身原子」；一旦替换成功、
   * 重启又没被受理，现役 `dist/` 已经变成新版本了，必须有一份可信的旧产物把它换回来。
   * 归档（`data/packages/`）+ `deploy-state.json` 的 `applied*` 就是这份保险。
   */
  private async restorePrevious(previous: DeployState | undefined): Promise<string | undefined> {
    if (!previous || previous.appliedVersion.length === 0) {
      return undefined;
    }
    const archive = findArchivedBundle(this.archiveDir, previous.appliedVersion);
    if (!archive) {
      return undefined;
    }
    const unpack = join(this.workDir, `.restore-${safeSegment(previous.appliedVersion)}`);
    try {
      rmSync(unpack, { recursive: true, force: true });
      mkdirSync(unpack, { recursive: true });
      extractTarGz(readFileSync(archive), unpack);
      swapTargets(this.root, unpack);
      log.warn("previous package restored in place", {
        version: previous.appliedVersion,
      });
      return previous.appliedVersion;
    } catch (error) {
      log.error("restore previous package failed", {
        version: previous.appliedVersion,
        error: describeError(error),
      });
      return undefined;
    } finally {
      rmSync(unpack, { recursive: true, force: true });
    }
  }

  private unpackDir(version: string): string {
    return join(this.workDir, safeSegment(version));
  }

  private unpackTmpDir(): string {
    return join(this.workDir, `.probe-${process.pid}`);
  }

  /** 失败私信的**去重键**：同一份包同一种原因只发一次（不刷屏）。 */
  private logDedupe(meta: DeployPackage, code: string): string {
    return `${code}:${meta.version}:${meta.sha256.slice(0, 12)}`;
  }

  private async reportFailure(
    code: InstallErrorCode,
    meta: DeployPackage,
    message: string,
  ): Promise<void> {
    const key = this.logDedupe(meta, code);
    if (this.reported.has(key)) {
      log.warn("deploy failure already reported, skipping notice", {
        version: meta.version,
        code,
      });
      return;
    }
    this.reported.add(key);
    const card: InstallNotice = {
      title:
        code === "sha_mismatch" || code === "unpack_failed"
          ? "部署包校验失败"
          : code === "self_check_failed" || code === "version_mismatch"
            ? "部署包自证不过"
            : "部署没能应用",
      lines: [
        `**目标版本**：v${meta.version}`,
        `**原因**：${message}`,
        "",
        code === "sha_mismatch"
          ? "这是**半传**的典型表现（FTP 还没传完）。这次部署被拒绝，运行中的机器人不受影响；重新发布一次即可。"
          : "这次部署被拒绝，运行中的机器人不受影响；确认包与 `dist/` 之后再重新发布。",
      ],
      kind:
        code === "sha_mismatch" || code === "unpack_failed"
          ? "half-transferred"
          : code === "replace_failed" || code === "restart_rejected"
            ? "replace-failed"
            : "self-check-failed",
      version: meta.version,
    };
    for (const userId of this.recipients()) {
      try {
        await this.notify(userId, card);
      } catch (error) {
        log.warn("deploy failure notice not delivered", {
          userId,
          error: describeError(error),
        });
      }
    }
  }

  /** 只读获取（`rollbackTarget()` 之外还用它读版本号做展示）。供命令层 / 后台用。 */
  public appliedVersion(): string {
    return this.state()?.appliedVersion ?? "";
  }
}

// ---------------------------------------------------------------------- 状态

/** 读部署状态（缺文件 / 坏 JSON → `undefined`：诊断信息永远不能让启动或巡检失败）。 */
export function readDeployState(file: string): DeployState | undefined {
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return {
      appliedVersion: str(record.appliedVersion),
      appliedSha: str(record.appliedSha),
      previousVersion: str(record.previousVersion),
      previousSha: str(record.previousSha),
    };
  } catch (error) {
    log.debug("deploy state unreadable", { file, error: describeError(error) });
    return undefined;
  }
}

export function writeDeployState(file: string, state: DeployState): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 部署回执（成功 / 失败都写；运维 SOP 直接 `cat data/deploy-receipt.json`）。 */
export interface DeployReceipt {
  at: string;
  actor: string;
  ok: boolean;
  code: string;
  version: string;
  message: string;
  fromVersion?: string | undefined;
}

export function readDeployReceipt(file: string = DEPLOY_RECEIPT_FILE): DeployReceipt | undefined {
  try {
    if (!existsSync(file)) {
      return undefined;
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return {
      at: str(record.at),
      actor: str(record.actor),
      ok: record.ok === true,
      code: str(record.code),
      version: str(record.version),
      message: str(record.message),
      ...(typeof record.fromVersion === "string" ? { fromVersion: record.fromVersion } : {}),
    };
  } catch (error) {
    log.debug("deploy receipt unreadable", { file, error: describeError(error) });
    return undefined;
  }
}

async function writeReceipt(file: string, receipt: DeployReceipt): Promise<void> {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  } catch (error) {
    log.warn("deploy receipt write failed", { file, error: describeError(error) });
  }
}

// ---------------------------------------------------------------------- 投递箱

interface PendingPackage {
  jsonPath: string;
  /** 落地时间（`incoming/` 的保留策略按它排序）。 */
  at: number;
}

/** 扫 `incoming/deploy-*.json`（只认还没被改名成 `*.failed-*` 的）。 */
export function listPending(incomingDir: string): PendingPackage[] {
  let names: string[];
  try {
    names = readdirSync(incomingDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^deploy-.*\.json$/u.test(name))
    .map((name) => {
      const jsonPath = join(incomingDir, name);
      let at = 0;
      try {
        at = statSync(jsonPath).mtimeMs;
      } catch {
        at = 0;
      }
      return { jsonPath, at };
    })
    .sort((a, b) => a.at - b.at)
    .map((item) => ({ jsonPath: item.jsonPath, at: item.at }));
}

/** 解析投递标记（`deploy-<版本>.json`）：字段不全 → `undefined`（当坏包处理）。 */
export function readPackageMeta(file: string): DeployPackage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    log.debug("deploy marker unreadable", { file, error: describeError(error) });
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const version = str(record.version);
  const sha256 = str(record.sha256);
  if (version.length === 0 || sha256.length === 0) {
    return undefined;
  }
  return {
    version,
    commit: str(record.commit),
    sha256,
    distFingerprint: str(record.distFingerprint),
    builtAt: str(record.builtAt),
  };
}

/** 归档里某个版本的包路径（`data/packages/deploy-<版本>.tgz`）。 */
export function findArchivedBundle(archiveDir: string, version: string): string | undefined {
  if (version.length === 0) {
    return undefined;
  }
  const direct = join(archiveDir, `deploy-${safeSegment(version)}.tgz`);
  if (existsSync(direct)) {
    return direct;
  }
  // 归档可能被加了时间戳前缀（历史上手工归档过），兜底按包含匹配
  try {
    const hit = readdirSync(archiveDir).find(
      (name) => name.endsWith(`_deploy-${safeSegment(version)}.tgz`) || name === `deploy-${safeSegment(version)}.tgz`,
    );
    return hit !== undefined ? join(archiveDir, hit) : undefined;
  } catch {
    return undefined;
  }
}

/** 把包归档到 `data/packages/`（同名直接覆盖；保留最近 `PACKAGE_KEEP` 个）。 */
export function archiveBundle(
  archive: string,
  meta: DeployPackage,
  archiveDir: string,
): string | undefined {
  try {
    mkdirSync(archiveDir, { recursive: true });
    const target = join(archiveDir, `deploy-${safeSegment(meta.version)}.tgz`);
    copyFileSync(archive, target);
    // 归档的「新旧」按落地时刻算，而不是继承源文件的 mtime（否则保留策略会误删新包）
    const now = new Date();
    try {
      utimesSync(target, now, now);
    } catch {
      // 改不动 mtime 不影响功能
    }
    return target;
  } catch (error) {
    log.warn("package archive failed", { archive, error: describeError(error) });
    return undefined;
  }
}

/** `incoming/` 只留最近 `PACKAGE_KEEP` 个包（含对应的 `.tgz` 与标记 `.json`）。 */
export function trimIncoming(incomingDir: string, keep: number = PACKAGE_KEEP): void {
  const pending = listPending(incomingDir).sort((a, b) => b.at - a.at);
  for (const item of pending.slice(keep)) {
    const version = basename(item.jsonPath).replace(/^deploy-/u, "").replace(/\.json$/u, "");
    rmSync(item.jsonPath, { force: true });
    rmSync(join(incomingDir, `deploy-${version}.tgz`), { force: true });
  }
  // 连带清掉孤儿 `.tgz`（标记被改名 / 删掉了：留它也永远不会被应用）
  // ⚠️ `*.failed-<ts>` 是**留证**，不在清理范围内（真机事故的现场要留着查）。
  let names: string[] = [];
  try {
    names = readdirSync(incomingDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".tgz") || name.includes(".failed-")) {
      continue;
    }
    const version = name.replace(/^deploy-/u, "").replace(/\.tgz$/u, "");
    if (!existsSync(join(incomingDir, `deploy-${version}.json`))) {
      rmSync(join(incomingDir, name), { force: true });
    }
  }
}

/** `data/packages/` 只留最近 `PACKAGE_KEEP` 个包（**回滚靠它，所以不按版本号排**）。 */
export function trimArchive(archiveDir: string, keep: number = PACKAGE_KEEP): void {
  let entries: Array<{ path: string; at: number }>;
  try {
    entries = readdirSync(archiveDir)
      .filter((name) => name.endsWith(".tgz"))
      .map((name) => {
        const path = join(archiveDir, name);
        let at = 0;
        try {
          at = statSync(path).mtimeMs;
        } catch {
          at = 0;
        }
        return { path, at };
      });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => b.at - a.at).slice(keep)) {
    rmSync(entry.path, { force: true });
  }
}

/**
 * 坏包改名留证：`deploy-<版本>.tgz` → `deploy-<版本>.tgz.failed-<ts>`。
 *
 * **只改 `incoming/` 里的原件**（`data/packages/` 是已应用成功的备份，不动）。
 * 同一份失败的包**不再进 `listPending()`**，所以不会反复重试 —— 想再试就重新上传一次。
 */
export function renameFailedPackage(
  archive: string,
  at: number,
  reported: Set<string>,
  key: string,
): void {
  if (reported.has(`failed:${key}`)) {
    return;
  }
  reported.add(`failed:${key}`);
  try {
    renameSync(archive, `${archive}.failed-${at}`);
  } catch (error) {
    log.warn("failed package rename skipped", {
      archive,
      error: describeError(error),
    });
  }
}

/** 对应的标记文件也改名（下次扫描不再看到它）。 */
export function markFailed(
  jsonPath: string,
  at: number,
  reported: Set<string>,
  code: string,
  detail: string,
): void {
  const key = `marker:${jsonPath}:${code}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  try {
    renameSync(jsonPath, `${jsonPath}.failed-${at}`);
    log.warn("deploy marker rejected", { jsonPath, code, detail });
  } catch (error) {
    log.warn("deploy marker rename failed", { jsonPath, error: describeError(error) });
  }
}

// ---------------------------------------------------------------------- 替换

/**
 * **整目录原子替换**：`dist` / `web/dist` / `scripts`。
 *
 * 逐个 target 做「旧 → `.prev`、新 → 正位」；**任何一个失败就整体回退**（把已经换掉的
 * 目录从 `.prev` 换回来），绝不留下半套（真机事故 2 的教训：混装 dist）。
 * 全部成功后再删 `.prev`（它只是替换期的保险）。
 *
 * `data/`、`.env`、`logs/` 与其它一切都不在替换面里 —— 只承认 `DEPLOY_TARGETS` 这三项。
 */
export function swapTargets(root: string, unpackDir: string, targets = DEPLOY_TARGETS): void {
  const backupSuffix = `.prev-${process.pid}`;
  // ⚠️ 缺目标**必须报错**，绝不静默跳过：`dist/` 是代码本体，缺了就等于「什么都没换」；
  // `web/dist` / `scripts` 缺了会留下半套产物。ADR-0073：0.30.0 那次「报成功但现役产物没动」
  // 能瞒过三道自检，这里原来的 `continue` 是最后一环 —— 换成抛错之后，这种包根本进不去。
  const missing = targets.filter((target) => !existsSync(join(unpackDir, target)));
  if (missing.length > 0) {
    throw new Error(
      `产物包缺少 ${missing.join(" / ")}（包必须包含 ${targets.join(" / ")}）`,
    );
  }
  const done: Array<{ target: string; hadPrev: boolean }> = [];
  try {
    for (const target of targets) {
      const live = join(root, target);
      const staged = join(unpackDir, target);
      mkdirSync(dirname(live), { recursive: true });
      const backup = `${live}${backupSuffix}`;
      rmSync(backup, { recursive: true, force: true });
      const hadPrev = existsSync(live);
      if (hadPrev) {
        renameSync(live, backup);
      }
      renameSync(staged, live);
      done.push({ target, hadPrev });
    }
    // 参考文件（依赖清单 / `.env.example`）：存在才刷新，不动替换面
    for (const extra of DEPLOY_REFERENCE_FILES) {
      const staged = join(unpackDir, extra);
      if (existsSync(staged)) {
        copyFileSync(staged, join(root, extra));
      }
    }
  } catch (error) {
    for (const item of [...done].reverse()) {
      const live = join(root, item.target);
      const backup = `${live}${backupSuffix}`;
      try {
        rmSync(live, { recursive: true, force: true });
        if (item.hadPrev) {
          renameSync(backup, live);
        }
      } catch (rollbackError) {
        log.error("swap rollback failed", {
          target: item.target,
          error: describeError(rollbackError),
        });
      }
    }
    throw error;
  }
  for (const item of done) {
    rmSync(`${join(root, item.target)}${backupSuffix}`, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------- 归档解析

/**
 * 读归档包内的 `build-info.json`（回滚路径用：归档里没有投递标记 `.json`）。
 *
 * 只做**只读**解析：解到临时目录 → 读 → 立刻删掉，不碰现役产物。
 */
export function readArchivedBuildInfo(
  archive: string,
  tmpDir: string,
): BuildInfo | undefined {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    extractTarGz(readFileSync(archive), tmpDir);
    return readBuildInfo(join(tmpDir, "dist"));
  } catch (error) {
    log.debug("archived build-info unreadable", { archive, error: describeError(error) });
    return undefined;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** 文件 sha256（读不到回 `undefined`）。 */
export function sha256OfFile(file: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch (error) {
    log.debug("sha256 unavailable", { file, error: describeError(error) });
    return undefined;
  }
}

/**
 * 极简 `.tar.gz` 解包（只读，够用即可）。
 *
 * 为什么自己解而不用系统 `tar`：产物包是 gzip + POSIX tar，格式极稳，而「解包」这一步
 * 必须在**任何**部署环境里都能跑（Windows 开发机、精简 Linux 容器不一定有 `tar`）。
 * 支持 ustar / GNU / pax 的普通文件与目录、GNU `L`（长名）与 pax `x` 扩展头；
 * **绝不写出目标目录之外**（`..` 与绝对路径一律拒绝）。
 */
export function extractTarGz(archive: Buffer, targetDir: string): void {
  const tar = gunzipSync(archive);
  const root = resolve(targetDir);
  let offset = 0;
  let pendingLongName: string | undefined;
  let pendingPaxPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      return;
    }
    const name = readCString(header, 0, 100);
    const size = parseTarNumber(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] ?? 48);
    const prefix = readCString(header, 345, 155);
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === "L") {
      pendingLongName = readCString(body, 0, body.length);
      continue;
    }
    if (typeFlag === "x" || typeFlag === "g") {
      pendingPaxPath = paxPath(body) ?? pendingPaxPath;
      continue;
    }

    const full = pendingPaxPath ?? pendingLongName ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
    pendingPaxPath = undefined;
    pendingLongName = undefined;
    if (full.length === 0) {
      continue;
    }
    const destination = safeJoin(root, full);
    if (typeFlag === "5" || full.endsWith("/")) {
      mkdirSync(destination, { recursive: true });
      continue;
    }
    if (typeFlag !== "0" && typeFlag !== "7" && typeFlag !== "\0") {
      // 符号链接 / 设备节点等一律忽略：产物包里不该有它们
      log.warn("tar entry skipped (unsupported type)", { name: full, typeFlag });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, body);
  }
}

/** 路径拼到目标目录里，并保证没有逃出去（防 tar 路径穿越）。 */
function safeJoin(root: string, name: string): string {
  const normalized = name.replace(/\\/gu, "/").replace(/^\/+/u, "");
  const destination = resolve(root, normalized);
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new Error(`tar entry escapes target dir: ${name}`);
  }
  return destination;
}

function readCString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  const content = end >= 0 ? slice.subarray(0, end) : slice;
  return content.toString("utf8").trim();
}

/** tar 数字字段：八进制（含结尾空格 / NUL），也接受 GNU 的 base-256。 */
function parseTarNumber(header: Buffer, start: number, length: number): number {
  const slice = header.subarray(start, start + length);
  if ((slice[0] ?? 0) & 0x80) {
    let value = 0;
    for (const byte of slice) {
      value = value * 256 + byte;
    }
    return value;
  }
  const text = slice.toString("utf8").replace(/\0/gu, "").trim();
  const value = Number.parseInt(text.length > 0 ? text : "0", 8);
  return Number.isFinite(value) ? value : 0;
}

/** 从 pax（`x`）扩展头里取 `path=` 字段。 */
function paxPath(body: Buffer): string | undefined {
  const text = body.toString("utf8");
  for (const line of text.split("\n")) {
    const match = /^\d+ path=(.*)$/u.exec(line);
    if (match?.[1] !== undefined && match[1].length > 0) {
      return match[1];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------- 小工具

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 目录 / 文件名安全化（版本号来自投递目录，不能让它带路径分隔符）。 */
function safeSegment(value: string): string {
  return value.replace(/[\\/]/gu, "_").replace(/\.\./gu, "_").trim() || "unknown";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
