import { defineStore } from "pinia";

import type { AdminApiEntityRef } from "@/api/admin";
import { api, ApiError } from "@/api/client";
import { groupLabel } from "@/lib/entity";

/**
 * 登录会话与权限画像（E2-a，与机器人同一套两轴模型）。
 *
 * 前端只把 `/auth/me` 给的画像当作**界面开关**：真正能不能干活一律由服务端判定
 * （只读端点有逐路由门槛，写端点按本群 130 / 平台 240 判），前端拿不到额外能力。
 */
export interface AdminPermissions {
  /** 平台档：`240` = 全局超管；`0` = 没有平台角色。 */
  platformLevel: number;
  /** 能真正干事的群（群内档 120 起，或平台档折算后的生效档）。 */
  groups: Array<{
    groupId: string;
    level: number;
    /** 展示信息：群号 → 短码 → 截断 id（老响应 / 巡检模式可能没有）。 */
    group?: AdminApiEntityRef;
  }>;
}

export interface AdminIdentity {
  userId: string | null;
  expiresAt: string;
  permissions?: AdminPermissions;
  /** 登录账号的展示信息（QQ号 → 短码 → 截断 id）；老响应没有时退回 `userId`。 */
  user?: AdminApiEntityRef;
}

/** 与后端 `PLATFORM_OFFSET` / `PLATFORM_LEVEL_MIN` 同一套折算（docs/ADMIN-API.md §1）。 */
const PLATFORM_OFFSET = 100;
const PLATFORM_LEVEL_MIN = 200;
/** 群管理员档：入群审批 / 规则写入 / 活动开关的门槛。 */
export const GROUP_ADMIN_LEVEL = 130;
/** 审核员档：只读端点（审计 / 规则查看 / 列表）的门槛。 */
export const MODERATOR_LEVEL = 120;
/** 平台超级管理员档：状态 / 话题门槛 / 全局规则的门槛。 */
export const GLOBAL_SUPER_ADMIN_LEVEL = 240;

export const useSessionStore = defineStore("session", {
  state: () => ({
    identity: null as AdminIdentity | null,
    /** 首次 `/auth/me` 是否已经跑过（避免每次进页面都闪一下登录态）。 */
    loaded: false,
    pending: false,
    error: "",
  }),

  getters: {
    signedIn: (state): boolean => state.identity?.userId != null,
    /** 平台档；没登录时是 0。 */
    platformLevel: (state): number =>
      state.identity?.permissions?.platformLevel ?? 0,
    /** 平台超管：能看状态 / 话题门槛 / 全局规则。 */
    isSuperAdmin(): boolean {
      return this.platformLevel >= GLOBAL_SUPER_ADMIN_LEVEL;
    },
    /** 某群的**生效**群内档位：`max(群内档, 平台档 - 100)`，与 `PermissionService.levelFor` 一致。 */
    levelIn(
      state,
    ): (groupId: string) => number {
      return (groupId: string): number => {
        const platform = state.identity?.permissions?.platformLevel ?? 0;
        const folded =
          platform >= PLATFORM_LEVEL_MIN ? platform - PLATFORM_OFFSET : 0;
        const own =
          state.identity?.permissions?.groups.find(
            (group) => group.groupId === groupId,
          )?.level ?? 0;
        return Math.max(own, folded);
      };
    },
    /**
     * 某群的展示文本（群号 → 短码 → 完整 id）。
     *
     * `/auth/me` 把展示信息一起给了，所以选择器和表格不必自己截断 id；
     * 老响应缺 `group` 时退回完整 id，至少不显示空白。
     */
    groupLabelIn(state): (groupId: string) => string {
      return (groupId: string): string => {
        const ref = state.identity?.permissions?.groups.find(
          (group) => group.groupId === groupId,
        )?.group;
        return groupLabel(ref, groupId);
      };
    },
  },

  actions: {
    /** 读当前会话（401 = 没登录，不算错误，调用方跳登录页）。 */
    async load(): Promise<void> {
      this.pending = true;
      try {
        // `silent401`：「我还没登录」是正常分支，不触发全局跳登录（路由守卫自己会跳）
        this.identity = await api.get<AdminIdentity>("/auth/me", {
          silent401: true,
        });
        this.error = "";
      } catch (error) {
        this.identity = null;
        if (error instanceof ApiError && error.status === 401) {
          this.error = "";
        } else {
          this.error = describeError(error);
        }
      } finally {
        this.loaded = true;
        this.pending = false;
      }
    },

    /** 用一次性令牌换会话 cookie（令牌来自机器人私信 / `pnpm admin:token`）。 */
    async login(token: string): Promise<void> {
      this.pending = true;
      try {
        await api.post("/auth/token", { token });
        this.error = "";
        await this.load();
      } catch (error) {
        this.error = describeError(error);
        throw error;
      } finally {
        this.pending = false;
      }
    },

    /** 登出：服务端删会话 + 清 cookie。 */
    async logout(): Promise<void> {
      try {
        await api.post("/auth/logout");
      } catch {
        // 登出失败也要把本地状态清掉：cookie 过期 / 服务重启都会走到这里
      }
      this.identity = null;
      this.error = "";
    },
  },
});

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
