import { describe, expect, it } from "vitest";

import { DEFAULT_GROUP_ID, GroupConfigStore } from "../src/services/groupConfig.js";
import type { RichMessage } from "../src/services/richMessages.js";
import {
  sendWelcome,
  WELCOME_MEMBER_PLACEHOLDER,
  type WelcomeDeps,
} from "../src/services/welcome.js";

/**
 * §H5 迎新：**仅群内**（用户明确不做私信欢迎）。
 *
 * 真机踩过两次相反的坑，所以两条通道都发：先纯文本 `content`（内嵌提及通道），
 * 再一张欢迎卡（Markdown 备注通道）；任一条成功就算发出去了，都失败只记日志。
 */
interface Calls {
  plain: Array<{ groupId: string; content: string }>;
  rich: Array<{ groupId: string; message: RichMessage }>;
  failPlain: boolean;
  failRich: boolean;
}

function createDeps(options: {
  failPlain?: boolean;
  failRich?: boolean;
} = {}): { deps: WelcomeDeps; calls: Calls; configStore: GroupConfigStore } {
  const configStore = new GroupConfigStore({ groupId: DEFAULT_GROUP_ID });
  const calls: Calls = {
    plain: [],
    rich: [],
    failPlain: options.failPlain ?? false,
    failRich: options.failRich ?? false,
  };
  const deps: WelcomeDeps = {
    configStore,
    sender: {
      sendPlainToGroup: async (groupId: string, content: string) => {
        calls.plain.push({ groupId, content });
        return { ok: !calls.failPlain, detail: calls.failPlain ? "blocked" : "", mode: "text" as const };
      },
      sendToGroup: async (groupId: string, message: RichMessage) => {
        calls.rich.push({ groupId, message });
        return { ok: !calls.failRich, detail: calls.failRich ? "blocked" : "", mode: "markdown" as const };
      },
    },
  };
  return { deps, calls, configStore };
}

describe("sendWelcome", () => {
  it("默认关：一条消息都不发", async () => {
    const { deps, calls } = createDeps();

    await expect(sendWelcome(deps, "g1", "newbie")).resolves.toBe("disabled");
    expect(calls.plain).toHaveLength(0);
    expect(calls.rich).toHaveLength(0);
  });

  it("开启后两条通道都发，{成员} 替换成 @ 该成员", async () => {
    const { deps, calls, configStore } = createDeps();
    configStore.setOverride({
      groupId: "g1",
      welcomeEnabled: true,
      welcomeMessage: `欢迎 ${WELCOME_MEMBER_PLACEHOLDER} 加入本群！`,
    });

    await expect(sendWelcome(deps, "g1", "newbie")).resolves.toBe("sent");

    expect(calls.plain).toHaveLength(1);
    expect(calls.plain[0]?.groupId).toBe("g1");
    expect(calls.plain[0]?.content).toBe("欢迎 <@!newbie> 加入本群！");

    expect(calls.rich).toHaveLength(1);
    const markdown = calls.rich[0]?.message.markdown ?? "";
    expect(markdown).toContain("## 欢迎新成员");
    expect(markdown).toContain("<@!newbie>");
    expect(markdown).toContain("加入本群");
  });

  it("欢迎语没写 {成员} 时自动在开头 @ 他", async () => {
    const { deps, calls, configStore } = createDeps();
    configStore.setOverride({
      groupId: "g1",
      welcomeEnabled: true,
      welcomeMessage: "请先看群规则。",
    });

    await sendWelcome(deps, "g1", "newbie");

    expect(calls.plain[0]?.content).toBe("<@!newbie> 请先看群规则。");
    // 卡片：@ 单独一行，插在标题下面
    expect(calls.rich[0]?.message.markdown).toContain(
      "## 欢迎新成员\n<@!newbie>\n请先看群规则。",
    );
  });

  it("欢迎语被清空 = 不欢迎（不发空卡片）", async () => {
    const { deps, calls, configStore } = createDeps();
    configStore.setOverride({
      groupId: "g1",
      welcomeEnabled: true,
      welcomeMessage: "   ",
    });

    await expect(sendWelcome(deps, "g1", "newbie")).resolves.toBe("disabled");
    expect(calls.rich).toHaveLength(0);
  });

  it("只开一个群：别的群不受影响", async () => {
    const { deps, calls, configStore } = createDeps();
    configStore.setOverride({
      groupId: "g1",
      welcomeEnabled: true,
      welcomeMessage: "欢迎 {成员}",
    });

    await expect(sendWelcome(deps, "g2", "newbie")).resolves.toBe("disabled");
    expect(calls.plain).toHaveLength(0);
  });

  it("两条通道都失败时返回 failed（但已有其它通道时算成功）", async () => {
    const { deps, configStore } = createDeps({ failRich: true });
    configStore.setOverride({
      groupId: "g1",
      welcomeEnabled: true,
      welcomeMessage: "欢迎 {成员}",
    });
    await expect(sendWelcome(deps, "g1", "newbie")).resolves.toBe("sent");

    const both = createDeps({ failPlain: true, failRich: true });
    both.configStore.setOverride({
      groupId: "g1",
      welcomeEnabled: true,
      welcomeMessage: "欢迎 {成员}",
    });
    await expect(sendWelcome(both.deps, "g1", "newbie")).resolves.toBe("failed");
  });
});
