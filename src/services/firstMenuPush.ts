import { getLogger } from "../core/logger.js";
import type { MenuFirstPushMode } from "../config.js";
import type { MenuDeliveryRepository } from "../db/menuDeliveryRepository.js";
import { WriteQueue } from "../db/writeQueue.js";

const log = getLogger("first-menu-push");

/**
 * 私信「首次交互推一次主菜单」的去重状态。
 *
 * 两种实现对应两种启动方式（见 `src/dev.ts` 与 `MENU_FIRST_PUSH`）：
 * - `MemoryFirstMenuPushState`：dev 启动，只记内存，重启可以再次验证推送；
 * - `PersistentFirstMenuPushState`：正式启动（默认），落库 `menu_deliveries`，重启不重复。
 *
 * `claim()` 是同步的（事件处理链上同步判断），载入在 `load()` 里一次完成，写入走
 * `WriteQueue` 顺序落库 —— 与项目里其它状态「内存缓存 + 写穿透」的做法一致。
 */
export interface FirstMenuPushState {
  /** 首次调用返回 true，之后返回 false。 */
  claim(userId: string): boolean;
  /** 从数据库载入已推送用户；内存实现为空操作。 */
  load(): Promise<void>;
  /** 等待排队写入落库。 */
  flush(): Promise<void>;
}

export class MemoryFirstMenuPushState implements FirstMenuPushState {
  private readonly pushed = new Set<string>();

  public claim(userId: string): boolean {
    if (this.pushed.has(userId)) {
      return false;
    }
    this.pushed.add(userId);
    return true;
  }

  public async load(): Promise<void> {
    // 内存实现不需要载入
  }

  public async flush(): Promise<void> {
    // 内存实现不需要落库
  }
}

/**
 * 热切换实现（`MENU_FIRST_PUSH` 可在 `/config` 里改）：去重集合始终只有一份，
 * **当前模式只决定要不要落库** —— 这样切换模式不会「忘记已经推过谁」。
 *
 * 数据库可用时启动会把历史已推送用户读进来（内存模式读到的行不影响行为：
 * 只有 `persistent` 才写库）。
 */
export class HotFirstMenuPushState implements FirstMenuPushState {
  private readonly pushed = new Set<string>();
  private readonly queue: WriteQueue | undefined;

  public constructor(
    private readonly mode: () => MenuFirstPushMode,
    private readonly repository?: MenuDeliveryRepository,
    queue?: WriteQueue,
  ) {
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public async load(): Promise<void> {
    this.pushed.clear();
    for (const userId of (await this.repository?.findAll()) ?? []) {
      this.pushed.add(userId);
    }
    log.debug("first menu push state loaded", {
      count: this.pushed.size,
      mode: this.mode(),
    });
  }

  public claim(userId: string): boolean {
    if (this.pushed.has(userId)) {
      return false;
    }
    this.pushed.add(userId);
    if (this.mode() === "persistent" && this.repository && this.queue) {
      const pushedAt = new Date().toISOString();
      const repository = this.repository;
      this.queue.enqueue("menu_deliveries.save", () =>
        repository.markPushed(userId, pushedAt),
      );
    }
    return true;
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }
}

export class PersistentFirstMenuPushState implements FirstMenuPushState {
  private readonly pushed = new Set<string>();

  public constructor(
    private readonly repository: MenuDeliveryRepository,
    private readonly queue: WriteQueue = new WriteQueue(),
  ) {}

  public async load(): Promise<void> {
    this.pushed.clear();
    for (const userId of await this.repository.findAll()) {
      this.pushed.add(userId);
    }
    log.debug("first menu push state loaded", { count: this.pushed.size });
  }

  public claim(userId: string): boolean {
    if (this.pushed.has(userId)) {
      return false;
    }
    this.pushed.add(userId);
    const pushedAt = new Date().toISOString();
    this.queue.enqueue("menu_deliveries.save", () =>
      this.repository.markPushed(userId, pushedAt),
    );
    return true;
  }

  public async flush(): Promise<void> {
    await this.queue.flush();
  }
}
