import type { IdentityMapService } from "./identityMap.js";
import {
  SHORT_CODE_PREFIX,
  type ShortCodeKind,
  type ShortCodeService,
} from "./shortCodes.js";

/**
 * 统一的「对外展示 / 命令参数解析」层。
 *
 * 展示规则（用户要求）：
 * - 已绑定 QQ号 / 群号 → 只显示解析号（QQ号 / 群号）；
 * - 未绑定 → 显示随机短码（`#M7K2Q9`），**绝不暴露**内部 `userId` / `group_openid`；
 * - 入群申请 → 一律显示短码，替代又长又难读的 `join_request_id`；
 * - `/whois` 是唯一例外：超级管理员可用它查询短码/QQ号背后的真实系统 id。
 *
 * 命令参数同时接受「解析号」与「短码」，因此卡片按钮、复制出来的指令都能直接执行。
 */
export class DisplayNameService {
  public constructor(
    private readonly identityMap: IdentityMapService,
    private readonly shortCodes: ShortCodeService,
  ) {}

  /** 展示用户：QQ号 或 `#短码`。 */
  public user(officialId: string): string {
    return (
      this.identityMap.getQq(officialId) ??
      this.shortCodes.label("user", officialId)
    );
  }

  /** 展示群：群号 或 `#短码`。 */
  public group(groupId: string): string {
    return (
      this.identityMap.getGroupNumber(groupId) ??
      this.shortCodes.label("group", groupId)
    );
  }

  /** 展示申请：一律 `#短码`。 */
  public request(requestId: string): string {
    return this.shortCodes.label("join_request", requestId);
  }

  /** 解析 `#短码` → 内部 userId；不是短码时返回 undefined（由调用方回退到 QQ号/openid 解析）。 */
  public resolveUser(input: string): string | undefined {
    return this.resolveKind(input, "user");
  }

  /** 解析 `#短码` → 内部 group_openid。 */
  public resolveGroup(input: string): string | undefined {
    return this.resolveKind(input, "group");
  }

  /**
   * 解析申请参数：`#短码` → 真实 join_request_id；
   * 也兼容直接传完整 id（旧消息/手工粘贴），此时原样返回。
   */
  public resolveRequest(input: string): string | undefined {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const resolved = this.resolveKind(trimmed, "join_request");
    return resolved ?? trimmed;
  }

  /** 是否为短码格式（用于提示与错误信息）。 */
  public isShortCode(input: string): boolean {
    return input.trim().startsWith(SHORT_CODE_PREFIX);
  }

  /** 解析任意类型的短码，供 `/whois` 还原真实系统 id。 */
  public resolveCode(
    input: string,
  ): { code: string; kind: ShortCodeKind; targetId: string } | undefined {
    return this.shortCodes.resolve(input);
  }

  private resolveKind(
    input: string,
    kind: ShortCodeKind,
  ): string | undefined {
    const resolved = this.shortCodes.resolve(input);
    if (!resolved || resolved.kind !== kind) {
      return undefined;
    }
    return resolved.targetId;
  }
}
