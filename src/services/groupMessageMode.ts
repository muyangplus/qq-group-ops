import type { GroupMessageModeRepository } from "../db/groupMessageModeRepository.js";
import { WriteQueue } from "../db/writeQueue.js";

export type GroupMessageMode = "all" | "at_only" | "unknown";

export class GroupMessageModeRegistry {
  private readonly modes = new Map<string, "all" | "at_only">();
  private readonly repository: GroupMessageModeRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(
    repository?: GroupMessageModeRepository,
    queue?: WriteQueue,
  ) {
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const records = await this.repository.findAll();
    this.modes.clear();
    for (const record of records) {
      this.modes.set(record.groupId, record.mode);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public setEnabled(groupId: string, enabled: boolean): void {
    const mode = enabled ? "all" : "at_only";
    this.modes.set(groupId, mode);
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("group-message-mode.save", () =>
        repository.save({ groupId, mode }),
      );
    }
  }

  public get(groupId: string): GroupMessageMode {
    return this.modes.get(groupId) ?? "unknown";
  }

  public list(): Array<{ groupId: string; mode: "all" | "at_only" }> {
    return [...this.modes.entries()].map(([groupId, mode]) => ({ groupId, mode }));
  }
}
