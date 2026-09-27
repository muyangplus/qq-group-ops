/**
 * `/restart` 的重启钩子。
 *
 * 机器人**自己重启自己**的可靠做法是「优雅关闭 → 进程退出」，由进程管理器拉起：
 * 本项目的 `docker-compose.yml` 两个服务都写了 `restart: unless-stopped`，
 * systemd `Restart=always` / pm2 同理。所以这里只暴露一个钩子：
 * `main.ts` 把「写重启回执 + 延迟调用既有 shutdown()」注入进来，命令层只管调用。
 *
 * 没注入钩子（例如纯单测、或有人直接 `node dist/main.js` 起进程）时
 * `available === false`，`/restart` 会明确拒绝而不是把进程杀掉。
 */
export interface RestartHook {
  /** 是否装配了可用的重启钩子。 */
  readonly available: boolean;
  /** 安排一次重启；返回是否受理。 */
  request(info: { requestedBy: string }): boolean;
}

export function createRestartHook(
  handler?: ((info: { requestedBy: string }) => void) | undefined,
): RestartHook {
  return {
    get available(): boolean {
      return handler !== undefined;
    },
    request(info): boolean {
      if (!handler) {
        return false;
      }
      handler(info);
      return true;
    },
  };
}
