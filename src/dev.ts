process.env.LOG_LEVEL ??= "DEBUG";
// 开发入口：私信首次交互的主菜单只记内存，重启可以再次验证推送效果。
// 正式入口（node dist/main.js）默认入库持久化，可用 MENU_FIRST_PUSH=memory|persistent 覆盖。
process.env.MENU_FIRST_PUSH ??= "memory";

await import("./main.js");
