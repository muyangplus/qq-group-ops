<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";

import {
  GROUP_ADMIN_LEVEL,
  MODERATOR_LEVEL,
  useSessionStore,
} from "@/stores/session";

/**
 * 概览（E2-c）：登录账号的权限画像 + 各页入口。
 *
 * 只读门槛在服务端（docs/ADMIN-API.md 的 E1-g），这里按同一份画像决定显示什么：
 * 审核员 120 起能看待审批列表、群管理员 130 起才能通过 / 拒绝、平台超管才看得到状态。
 */
const session = useSessionStore();

const groups = computed(() => session.identity?.permissions?.groups ?? []);
const reviewable = computed(() =>
  groups.value.filter((group) => group.level >= MODERATOR_LEVEL),
);
const manageable = computed(() =>
  groups.value.filter((group) => group.level >= GROUP_ADMIN_LEVEL),
);
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
        <dd>
          {{ session.platformLevel || "无平台角色" }}
          <span v-if="session.isSuperAdmin" class="hint">（平台超管）</span>
        </dd>
        <dt>能审批的群</dt>
        <dd>
          <span v-if="manageable.length === 0" class="hint">
            没有（需要群管理员 130）
          </span>
          <ul v-else class="groups">
            <li v-for="group in manageable" :key="group.groupId">
              <code>{{ group.groupId }}</code> · 档位 {{ group.level }}
            </li>
          </ul>
        </dd>
        <dt>能查看的群</dt>
        <dd>
          <span v-if="reviewable.length === 0" class="hint">
            没有（需要审核员 120）
          </span>
          <span v-else>{{ reviewable.length }} 个</span>
        </dd>
      </dl>

      <div class="toolbar">
        <RouterLink class="button" :to="{ name: 'pending' }">
          {{ manageable.length > 0 ? "去审批" : "查看待审批" }}
        </RouterLink>
        <RouterLink class="button" :to="{ name: 'audit' }">审计查询</RouterLink>
        <RouterLink class="button" :to="{ name: 'rules' }">规则编辑</RouterLink>
        <RouterLink class="button" :to="{ name: 'activities' }">活动</RouterLink>
        <RouterLink
          v-if="session.isSuperAdmin"
          class="button"
          :to="{ name: 'status' }"
        >
          运行状态
        </RouterLink>
      </div>

      <p class="hint">
        「规则编辑」里提交前会给 diff 并写 <code>admin_api:rule_update</code> 审计；
        活动的「名单 / 完整名单」直接下载 CSV（默认脱敏，完整版含学号 / 班级 / 学院），
        两种都要求本群群管理员并写审计。
      </p>
    </template>
  </section>
</template>
