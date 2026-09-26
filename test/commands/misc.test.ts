import { JoinRequestStatus } from "../../src/core/enums.js";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  joinAudit,
  configStore,
  identityMap,
  api,
  notifications,
  service,
  privateText,
  withSender,
  withShortCodes,
  withProfiles,
  scopedShortCodeLabel,
} from "../helpers/adminCommandsHarness.js";

/**
 * AdminCommandService 集成测试 · misc（21 个用例）。
 */

describe("AdminCommandService · misc", () => {
  it("supports topic aliases and leading slash", async () => {
    const alias = await service.handle("g1", "admin", "/help 规则");
    expect(alias.ok).toBe(true);
    expect(alias.text).toContain("/rules — 群规则配置");

    const withSlash = await service.handle("g1", "admin", "/help /rules");
    expect(withSlash.ok).toBe(true);
    expect(withSlash.text).toContain("/rules set keywords");
  });

  it("hides topic details the user cannot execute", async () => {
    const result = await service.handle("g1", "member", "/help rules");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("权限不足");
    expect(result.text).toContain("需要");
    expect(result.text).not.toContain("/rules set keywords");
  });

  it("denies platform level topics to group roles", async () => {
    const rulesAdmin = await service.handle("g1", "admin", "/help perm");
    expect(rulesAdmin.ok).toBe(false);
    expect(rulesAdmin.text).toContain("仅全局超级管理员");

    const perm = await service.handle("g1", "root", "/help perm");
    expect(perm.ok).toBe(true);
    expect(perm.text).toContain("/perm grant gsuper");
  });

  it("reports invalid request ids", async () => {
    const result = await service.handle("g1", "admin", "/approve missing");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("审批失败");
  });

  it("shows status", async () => {
    const result = await service.handle("g1", "mod", "/status");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("全量消息模式");
    expect(result.text).toContain("禁言时长");
  });

  it("responds to /test for reviewers", async () => {
    const result = await service.handle("g1", "mod", "/test");
    expect(result.ok).toBe(true);
    expect(result.text).toContain("测试成功");
    expect(result.text).toContain("待审批申请");
  });

  it("configures join decision and answer requirements", async () => {
    await service.handle("g1", "admin", "/rules set joinDecision reject_on_mismatch");
    await service.handle("g1", "admin", "/rules set joinRequireClass on");
    await service.handle("g1", "admin", "/rules set joinRequireName 是");
    await service.handle(
      "g1",
      "admin",
      "/rules set joinAnswerPattern ^材化\\d{4}\\s+\\S{2,4}$",
    );
    await service.handle("g1", "admin", "/rules set joinReviewOpinion off");

    const config = configStore.get("g1");
    expect(config.joinDecision).toBe("reject_on_mismatch");
    expect(config.joinRequireClass).toBe(true);
    expect(config.joinRequireName).toBe(true);
    expect(config.joinAnswerPattern).toContain("材化");
    expect(config.joinReviewOpinion).toBe(false);

    // 中文别名 + clear
    await service.handle("g1", "admin", "/rules set 入群决策 命中通过");
    expect(configStore.get("g1").joinDecision).toBe("approve_on_match");
    await service.handle("g1", "admin", "/rules set 入群正则 clear");
    expect(configStore.get("g1").joinAnswerPattern).toBe("");

    const invalidDecision = await service.handle(
      "g1",
      "admin",
      "/rules set joinDecision nope",
    );
    expect(invalidDecision.ok).toBe(false);
    expect(invalidDecision.text).toContain("manual / auto_approve");

    const invalidPattern = await service.handle(
      "g1",
      "admin",
      "/rules set joinAnswerPattern ([bad",
    );
    expect(invalidPattern.ok).toBe(false);
    expect(invalidPattern.text).toContain("不合法");
  });

  it("requires group_openid for group commands in private", async () => {
    const missing = await service.handle(undefined, "root", "/pending");
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("群号");

    const withGroup = await service.handle(undefined, "root", "/pending g1");
    expect(withGroup.ok).toBe(true);
  });

  it("caps muteDuration at 30 days", async () => {
    await service.handle("g1", "admin", "/rules set muteDuration 99999999999");

    expect(configStore.get("g1").muteDurationSeconds).toBe(30 * 24 * 60 * 60);
  });

  it("resets global warning text to the builtin default with clear", async () => {
    await service.handle("g1", "root", "/rules set all warning 全局警告");
    expect(configStore.default.warningMessage).toBe("全局警告");

    await service.handle("g1", "root", "/rules set all warning clear");
    expect(configStore.default.warningMessage).toBe(
      "请遵守群规，不要发送违规内容。",
    );
  });

  it("reports sync failures", async () => {
    api.failJoinRequestList = true;

    const result = await service.handle("g1", "mod", "/sync");

    expect(result.ok).toBe(false);
    expect(result.text).toContain("同步失败");
  });

  it("subscribes a specific group through the menu callback", async () => {
    // 统一菜单后不再有 `/notify <群> on`；回调带上群 id，直接订该群
    const result = await service.notifyToggleCard("join", "g1", true, "admin", "g1");
    expect(result.ok).toBe(true);
    expect(notifications.isSubscribed("admin", "g1", "join")).toBe(true);
  });

  it("refuses subscribing to a group where the user has no role", async () => {
    identityMap.bindGroup("g2", "777777");
    const result = await service.notifyToggleCard("join", "g2", true, "admin", "g1");
    expect(result.ok).toBe(false);
    expect(result.rich.markdown).toContain("权限不足");
  });

  it("persists the auto-decision notification switch", async () => {
    const result = await service.handle(
      "g1",
      "admin",
      "/rules set notifyAutoApproved on",
    );
    expect(result.ok).toBe(true);
    expect(configStore.get("g1").notifyAutoApproved).toBe(true);
    expect(result.text).toContain("自动处理也通知：true");

    const off = await service.handle(
      "g1",
      "admin",
      "/rules set 通知自动通过 off",
    );
    expect(off.ok).toBe(true);
    expect(configStore.get("g1").notifyAutoApproved).toBe(false);
  });

  it("completes approvals via callback with operator feedback", async () => {
    joinAudit.submit("g1", "u1", "理由", "r1");

    const result = await service.approveCard("g1", "r1", "admin", 1, "g1");

    expect(result.ok).toBe(true);
    expect(result.rich.markdown).toContain("已通过");
    // 反馈在开头**单独一行** @ 操作人，不再内联「操作人：…」
    expect(result.rich.markdown.split("\n")[1]).toBe("<@!admin>");
    expect(result.rich.markdown).not.toContain("操作人：");
    expect(joinAudit.get("r1")?.status).toBe(JoinRequestStatus.Approved);

    // 私聊回复不 @（操作人就是接收者本人）
    joinAudit.submit("g1", "u2", "理由2", "r2");
    const inPrivate = await service.approveCard("g1", "r2", "admin");
    expect(inPrivate.rich.markdown).not.toContain("<@!");
  });

  it("supports querying a mentioned member in a group", async () => {
    // 官方 at 段：<@!openid>
    const viaMention = await service.handle("g1", "root", "/whois <@!u3>");
    expect(viaMention.ok).toBe(true);
    expect(viaMention.text).toContain("已私信发送");
    const dm = privateText("root");
    expect(dm).toContain("userId：u3");
    expect(dm).toContain("QQ：10005");

    // @昵称 无法反查：A4 起也只走私信（群里静默）
    const nickname = await service.handle("g1", "root", "/whois @张三");
    expect(nickname.silent).toBe(true);
    expect(privateText("root")).toContain("无法从 @昵称 反查用户");
  });

  it("resolves #group and #user short codes in commands", async () => {
    const scoped = withShortCodes();
    identityMap.bindGroup("g2", "777777");
    const groupCode = scopedShortCodeLabel("group", "g2");

    // 私信里用群短码查看状态（root 是超管）
    const status = await scoped.handle(
      undefined,
      "root",
      `/status ${groupCode}`,
    );
    expect(status.ok).toBe(true);
    expect(status.text).toContain("群 777777 状态：");
  });

  it("parses a one-shot /profile set in any order and separator", async () => {
    const { svc, profiles } = withProfiles();

    const result = await svc.handle(
      "g1",
      "member",
      "/profile set 22123456789 材化2211 张三",
    );
    expect(result.ok).toBe(true);
    expect(result.silent).toBe(true);
    expect(privateText("member")).toContain("已更新：");
    expect(privateText("member")).toContain("识别到：");
    expect(profiles.get("member")).toMatchObject({
      name: "张三",
      studentId: "22123456789",
      className: "材化2211",
      college: "化学与生命科学学院",
      year: "22",
    });

    // 无分隔符 + 顺序颠倒
    const compact = await svc.handle(
      "g1",
      "mod",
      "/profile set 环工2414李四24123456789",
    );
    expect(compact.ok).toBe(true);
    expect(profiles.get("mod")).toMatchObject({
      name: "李四",
      studentId: "24123456789",
      className: "环工2414",
      college: "环境科学与工程学院",
      year: "24",
    });

    // `字段=值` 显式写法
    const explicit = await svc.handle(
      "g1",
      "admin",
      "/profile set 班级=材化2211 姓名=王五 学号=22123456789",
    );
    expect(explicit.ok).toBe(true);
    expect(profiles.get("admin")).toMatchObject({
      name: "王五",
      className: "材化2211",
    });
  });

  it("refuses an ambiguous or unparsable /profile set without writing", async () => {
    const { svc, profiles } = withProfiles();

    const ambiguous = await svc.handle(
      "g1",
      "member",
      "/profile set 材化2211 环工2414 张三",
    );
    expect(ambiguous.ok).toBe(false);
    expect(privateText("member")).toContain("多个班级");
    expect(privateText("member")).toContain("材化2211");
    expect(privateText("member")).toContain("环工2414");
    expect(profiles.get("member")).toBeUndefined();

    const leftover = await svc.handle(
      "g1",
      "member",
      "/profile set 材化2211 张三 abc",
    );
    expect(leftover.ok).toBe(false);
    expect(privateText("member")).toContain("无法识别");
    expect(profiles.get("member")).toBeUndefined();

    // 班级不在班级库里 → 整体不写入
    const unknownClass = await svc.handle(
      "g1",
      "member",
      "/profile set 班级=材化9999 姓名=张三",
    );
    expect(unknownClass.ok).toBe(false);
    expect(privateText("member")).toContain("不在班级库中");
    expect(profiles.get("member")).toBeUndefined();

    const empty = await svc.handle("g1", "member", "/profile set");
    expect(empty.ok).toBe(false);
    expect(privateText("member")).toContain("用法");
  });

  it("keeps the positional /profile set form working", async () => {
    const { svc, profiles } = withProfiles();

    const result = await svc.handle("g1", "member", "/profile set class 材化2211");
    expect(result.ok).toBe(true);
    expect(privateText("member")).toContain("已更新：班级");
    expect(profiles.get("member")).toMatchObject({
      className: "材化2211",
      college: "化学与生命科学学院",
      year: "22",
    });

    const cleared = await svc.handle("g1", "member", "/profile set class clear");
    expect(cleared.ok).toBe(true);
    expect(profiles.get("member")?.className).toBe("");
  });

  it("probes several @everyone spellings for /testat all and reports failures", async () => {
    const svc = withSender();

    const all = await svc.handle("g1", "root", "/testat all");
    expect(all.ok).toBe(true);
    // 3 条基础测试 + 8 条 @全体候选
    expect(all.text).toContain("已在群里发送 11 条测试消息");
    expect(api.sentMessages).toHaveLength(11);
    const probeTexts = api.sentMessages
      .slice(3)
      .map((message) => String(message.markdown ?? message.content ?? ""));
    const joined = probeTexts.join("\n");
    expect(joined).toContain("@everyone");
    expect(joined).toContain("<@!all>");
    expect(joined).toContain("<@!everyone>");
    expect(joined).toContain("@全体成员");
    // R1 抓到的官方入站原文形态（不带 `!`）必须在候选里
    expect(joined).toContain("<@all>");
    // 卡片与纯文本两种通道都要试到（纯文本条目不带 markdown）
    expect(
      api.sentMessages.filter((message) => message.markdown === undefined),
    ).toHaveLength(4);

    // 群发送整体失败：汇总卡如实报告，不抛错
    api.failGroupMessages = true;
    const failed = await svc.handle("g1", "root", "/testat");
    expect(failed.ok).toBe(true);
    expect(failed.text).toContain("失败");
  });
});
