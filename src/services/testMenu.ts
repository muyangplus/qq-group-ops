import { getLogger } from "../core/logger.js";
import { pageArg, pageCallback, parseCallback, type ParsedCallback } from "./callbackData.js";
import { renderCard, type CardButton } from "./cardTemplate.js";
import type { InteractionEvent } from "./eventRouter.js";
import type { PermissionService } from "./permissions.js";
import type { RichMessage } from "./richMessages.js";

const log = getLogger("test-menu");

/**
 * `/testmenu`：官方**回调按钮**翻页试验（仅全局超级管理员）。
 *
 * 官方能力边界（已核对文档 + 真机验证）：
 * - 回调按钮 `action.type = 1`：点击后官方推 `INTERACTION_CREATE`（`type=11`），
 *   `data.resolved.button_data` 带回按钮定义里的 `data`；
 * - 收到互动事件后**必须**调 `PUT /interactions/{id}` 回应，否则客户端一直 loading 到超时；
 * - **没有「更新原消息」的接口**，也**不能**把互动事件的 `id` 当 `msg_id` 发被动消息
 *   （真机实测群聊返回 `400 请求参数msg_id无效或越权`），所以翻页只能是"回包之后
 *   再发一条新消息"：旧卡片会留在聊天记录里，这是官方能力限制，不是实现取巧；
 * - 双通道兜底：卡片正文与第二行按钮给出 `/testmenu <页码>`。
 *
 * 按钮类型遵循 `docs/CARD-STANDARD.md`：导航用回调（`cb:testmenu:page:N`），
 * 手动翻页用指令按钮（`/testmenu N`）。
 */
export const TEST_MENU_NAMESPACE = "testmenu";
export const TEST_MENU_PAGE_COUNT = 3;

export function clampTestMenuPage(page: number): number {
  if (!Number.isFinite(page)) {
    return 1;
  }
  return Math.min(Math.max(Math.trunc(page), 1), TEST_MENU_PAGE_COUNT);
}

export function testMenuCallbackData(page: number): string {
  return pageCallback(TEST_MENU_NAMESPACE, clampTestMenuPage(page));
}

/** 解析回调数据：是 `/testmenu` 的翻页回调才返回页码。 */
export function parseTestMenuCallback(
  data: string | undefined,
): number | undefined {
  const parsed = parseCallback(data);
  if (!parsed || parsed.namespace !== TEST_MENU_NAMESPACE) {
    return undefined;
  }
  if (parsed.action !== "page") {
    return undefined;
  }
  const page = pageArg(parsed.args);
  return page === undefined ? undefined : clampTestMenuPage(page);
}

/** 渲染第 `page` 页（自动收敛到 1-3）。 */
export function buildTestMenuCard(page: number): RichMessage {
  const current = clampTestMenuPage(page);
  const rows: CardButton[][] = [];

  const navigationRow: CardButton[] = [];
  if (current > 1) {
    navigationRow.push(navigationButton("prev", "上一页", current - 1));
  }
  if (current < TEST_MENU_PAGE_COUNT) {
    navigationRow.push(navigationButton("next", "下一页", current + 1));
  }
  navigationRow.push(navigationButton("home", "返回首页", 1));
  rows.push(navigationRow);

  // 双通道：键盘能用但互动事件没开通时，至少还能用指令按钮翻页
  if (current < TEST_MENU_PAGE_COUNT) {
    rows.push([
      {
        id: "cmd-next",
        label: `指令翻页 ${current + 1}`,
        command: `/testmenu ${current + 1}`,
      },
    ]);
  }

  return renderCard({
    title: `测试菜单（第 ${current} / ${TEST_MENU_PAGE_COUNT} 页）`,
    lines: [
      "用于验证官方**回调按钮**（`INTERACTION_CREATE`）翻页。",
      `**当前页**：第 ${current} / ${TEST_MENU_PAGE_COUNT} 页`,
      "",
      `第 ${current} 页文案：这是翻页试验的第 ${current} 页。`,
      `手动翻页：/testmenu <页码>（1-${TEST_MENU_PAGE_COUNT}）`,
    ],
    rows,
    footer: [
      "点按钮后机器人会发出新的一页（官方不支持更新原卡片，旧卡片会留在聊天记录里）。",
    ],
  });
}

function navigationButton(
  id: string,
  label: string,
  page: number,
): CardButton {
  return {
    id,
    label,
    callbackData: testMenuCallbackData(page),
    style: id === "next" ? 1 : 0,
    permission: { type: 2 },
  };
}

export interface TestMenuDependencies {
  permissions: PermissionService;
}

/**
 * `/testmenu` 的回调 renderer（见 `docs/CARD-STANDARD.md`）。
 *
 * 回包与发送由 `CallbackRouter` 统一负责，这里只做权限校验 + 渲染卡片；
 * 非超管点击（卡片可能被转发）返回一张说明卡片，而不是静默失败。
 */
export class TestMenuService {
  private readonly permissions: PermissionService;

  public constructor(dependencies: TestMenuDependencies) {
    this.permissions = dependencies.permissions;
  }

  public async render(
    parsed: ParsedCallback,
    event: InteractionEvent,
  ): Promise<RichMessage | undefined> {
    if (parsed.namespace !== TEST_MENU_NAMESPACE || parsed.action !== "page") {
      return undefined;
    }
    const page = pageArg(parsed.args);
    const userId = event.userId;
    if (page === undefined || !userId) {
      return undefined;
    }
    if (!this.permissions.isSuperAdmin(userId)) {
      log.debug("testmenu callback denied", { userId });
      return renderCard({
        title: "权限不足",
        lines: ["仅全局超级管理员可以翻页：/testmenu"],
      });
    }
    return buildTestMenuCard(page);
  }
}
