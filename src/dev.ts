process.env.LOG_LEVEL ??= "DEBUG";
// 开发入口：私信首次交互的主菜单只记内存，重启可以再次验证推送效果。
// ⚠️ ADR-0066 之后 `MENU_FIRST_PUSH` 是**热改项**（生效值在库里）：这里只作为
// 「第一次启动时导入库」的来源 —— 本地库上跑过一次 `pnpm dev` 之后，
// `menuFirstPush` 就固定成 `memory` 了；想换回入库去重：`/config set menuFirstPush persistent`。
process.env.MENU_FIRST_PUSH ??= "memory";

await import("./main.js");
