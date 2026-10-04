import { describe, expect, it } from "vitest";

import { FakeQQOfficialAPI } from "../src/adapters/fakeQqOfficial.js";
import { createAdminApiBackend } from "../src/adminApi/backend.js";
import { ActivityExportService } from "../src/services/activityExport.js";
import { ActivityService } from "../src/services/activity.js";
import { AuditLogStore } from "../src/services/audit.js";
import { DEFAULT_GROUP_ID, GroupConfigStore } from "../src/services/groupConfig.js";
import { JoinApprovalService } from "../src/services/joinApproval.js";
import { JoinAuditService } from "../src/services/joinAudit.js";
import { PermissionService } from "../src/services/permissions.js";
import type { IdentityBindingRepository } from "../src/db/identityBindingRepository.js";

/**
 * 后台「群列表」的口径（`/auth/me` 的 `permissions.groups`）。
 *
 * 真机报过：`/whois` 里明明查得到某个群（群号 + 短码都有，说明 `/bind group` 绑好了），
 * 但管理平台里**只有别的群**、没有它 —— 因为群集合当时只取「有授权行的群 ∪ 有规则覆盖的群」，
 * 刚绑完、还没写过任何规则 / 授权行的群就漏了。绑定表才是「这个机器人管得到哪些群」的权威来源。
 */
function harness(boundGroups: string[]) {
  const api = new FakeQQOfficialAPI();
  const auditLog = new AuditLogStore();
  const joinAudit = new JoinAuditService(auditLog);
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const identityBindings = {
    findAll: async () =>
      boundGroups.map((groupId) => ({
        kind: "group" as const,
        officialId: groupId,
        externalId: "10001",
      })),
  } as unknown as IdentityBindingRepository;
  return createAdminApiBackend({
    permissions: new PermissionService({ superAdminIds: new Set(["boss"]) }),
    auditLog,
    joinAudit,
    joinApproval: new JoinApprovalService(api, joinAudit, configStore),
    configStore,
    activity: new ActivityService(),
    activityExport: new ActivityExportService({
      profiles: { get: () => undefined },
    }),
    identityBindings,
    mode: "official",
  });
}

describe("后台群列表：绑过的群也要出现", () => {
  it("只有绑定行（没有规则覆盖 / 授权行）的群，平台超管能看到", async () => {
    const backend = harness(["G-OPENID-PLACEHOLDER-0001"]);

    const view = await backend.permissionsOf("boss");

    expect(view.platformLevel).toBeGreaterThanOrEqual(240);
    expect(view.groups.map((group) => group.groupId)).toEqual([
      "G-OPENID-PLACEHOLDER-0001",
    ]);
  });

  it("群列表仍然按权限裁剪：跟这些群没关系的人看不到", async () => {
    const backend = harness(["g-bound"]);

    const stranger = await backend.permissionsOf("someone");

    expect(stranger.groups).toEqual([]);
  });
});
