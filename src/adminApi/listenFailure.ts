/**
 * 监听失败时的可操作提示（E1-d 的收尾）。
 *
 * 背景：管理 API 有**两个**入口，都用 `ADMIN_API_HOST:ADMIN_API_PORT`（默认 `127.0.0.1:8787`）：
 *
 * - 机器人进程内的监听口（读写都有，写操作只有它支持）；
 * - `pnpm admin:api` 只读巡检进程（写端点一律 503）。
 *
 * 两个入口同时起，后起的那个必然 `EADDRINUSE`。以前两边的报错都不说人话：
 * 机器人侧只记一句「监听失败」，巡检侧直接一句 `listen EADDRINUSE` 就退出，
 * 运维看不出「现在到底谁在服务、写操作还能不能用」。
 */

/** 判断是不是「端口已被占用」。Node 的错误对象上带 `code`，不同平台文案不同。 */
export function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === "EADDRINUSE") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE|address already in use/i.test(message);
}

export interface ListenFailureInput {
  error: unknown;
  host: string;
  port: number;
  /** 本次尝试起监听口的是谁：机器人进程内的监听口 / 只读巡检进程。 */
  who: "in-process" | "inspect";
}

/** 生成一行给人看的处理建议（会进日志，也会作为启动失败的说明）。 */
export function describeListenFailure(input: ListenFailureInput): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const address = `${input.host}:${input.port}`;
  if (!isAddressInUse(input.error)) {
    return (
      `管理 API 无法监听 ${address}：${message}。` +
      `检查 ADMIN_API_HOST / ADMIN_API_PORT 是否合法，以及运行账号有没有权限绑定该地址。`
    );
  }
  const other =
    input.who === "in-process"
      ? "很可能是 `pnpm admin:api`（只读巡检进程）先占了这个端口"
      : "很可能是机器人进程内的那个监听口正在用这个端口";
  const consequence =
    input.who === "in-process"
      ? "此时端口上服务的只有只读巡检进程：读接口能用，**写端点（审批 / 规则 / 活动 / 导出）会回 503**。"
      : "机器人进程内的监听口支持读写，巡检进程只是为了「不想重启机器人时的只读排查」。";
  return (
    `${address} 已被占用（EADDRINUSE）：${other}。${consequence}` +
    `处理：停掉占用方，或给其中一个换端口（例如只读巡检用 ADMIN_API_PORT=8788）。`
  );
}
