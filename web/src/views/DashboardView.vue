<script setup lang="ts">
import { useSessionStore } from "@/stores/session";

/**
 * 状态看板（E2-a 占位）。
 *
 * E2-c 会在这里接 `GET /api/status`：版本 / 运行时长 / 数据库 / 迁移问题数 / 有效令牌数 / 会话数，
 * 并按 `/auth/me` 的画像隐藏入口（平台超管才看得到）。
 */
const session = useSessionStore();
</script>

<template>
  <section class="card">
    <h1>概览</h1>
    <p v-if="session.pending">加载中…</p>
    <template v-else>
      <dl class="facts">
        <dt>登录账号</dt>
        <dd>{{ session.identity?.userId ?? "（未登录）" }}</dd>
        <dt>平台档</dt>
        <dd>{{ session.platformLevel || "无平台角色" }}</dd>
        <dt>可管理的群</dt>
        <dd>
          <span v-if="session.identity?.permissions?.groups.length === 0">
            没有（需要群审核员 120 或以上）
          </span>
          <ul v-else class="groups">
            <li
              v-for="group in session.identity?.permissions?.groups ?? []"
              :key="group.groupId"
            >
              <code>{{ group.groupId }}</code> · 档位 {{ group.level }}
            </li>
          </ul>
        </dd>
      </dl>
      <p class="hint">
        页面按计划逐项落地（E2-c）：状态看板 / 待审批 / 审计查询 / 规则编辑 / 活动开关。
        接口本身已就绪：<code>GET /api/status|pending|audit|rules|activities</code>，
        写操作走 <code>POST /api/pending/:id/approve|reject</code>、<code>PUT /api/rules</code>、
        <code>POST /api/activities/:code/open|close|cancel</code>。
      </p>
    </template>
  </section>
</template>
