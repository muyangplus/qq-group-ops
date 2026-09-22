export type GroupMessageMode = "all" | "at_only" | "unknown";

export class GroupMessageModeRegistry {
  private readonly modes = new Map<string, "all" | "at_only">();

  public setEnabled(groupId: string, enabled: boolean): void {
    this.modes.set(groupId, enabled ? "all" : "at_only");
  }

  public get(groupId: string): GroupMessageMode {
    return this.modes.get(groupId) ?? "unknown";
  }

  public list(): Array<{ groupId: string; mode: "all" | "at_only" }> {
    return [...this.modes.entries()].map(([groupId, mode]) => ({ groupId, mode }));
  }
}
