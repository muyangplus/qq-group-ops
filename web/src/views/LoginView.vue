<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

/**
 * 登录页（E2-a 建链路，E2-b 补会话保持与回跳）。
 *
 * 三种进入方式：
 * - 机器人私信里的**登录链接**：`<PUBLIC_BASE_URL>/login?token=…` → 直接兑换；
 * - 链接在 QQ 里点不动时：手工把令牌粘进输入框；
 * - 会话过期 / 被撤销：路由守卫带 `?expired=1` 进来，页面说明「是过期，不是令牌错」。
 */
const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const fromQuery = route.query["token"];
const token = ref(typeof fromQuery === "string" ? fromQuery : "");
const submitting = ref(false);
const localError = ref("");

const expired = computed(() => route.query["expired"] === "1");
const redirect = computed(() => {
  const value = route.query["redirect"];
  return typeof value === "string" && value.startsWith("/") ? value : "/";
});

const canSubmit = computed(
  () => token.value.trim().length > 0 && !submitting.value,
);

async function submit(): Promise<void> {
  if (!canSubmit.value) {
    return;
  }
  submitting.value = true;
  localError.value = "";
  try {
    await session.login(token.value.trim());
    // 回跳原地址（守卫来时记下的）；没有就回看板
    await router.replace(redirect.value);
  } catch {
    // 具体原因由 store 记在 error 里（令牌无效 / 已用过 / 过期都会说清）
    localError.value = session.error;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="card narrow">
    <h1>登录管理后台</h1>
    <p v-if="expired" class="error">
      会话已过期或被撤销（cookie 过期 / 机器人重启 / 换过会话密钥），请重新登录。
    </p>
    <p class="hint">
      在机器人私信里发送 <code>/admin login</code>（或服务器上执行
      <code>pnpm admin:token --user=&lt;openid&gt;</code>）拿一次性令牌：
      默认 10 分钟内有效、只能用一次。
    </p>

    <form class="stack" @submit.prevent="submit">
      <label for="token">一次性令牌</label>
      <input
        id="token"
        v-model="token"
        type="password"
        autocomplete="off"
        spellcheck="false"
        placeholder="粘贴令牌"
      />
      <button type="submit" :disabled="!canSubmit">
        {{ submitting ? "兑换中…" : "登录" }}
      </button>
    </form>

    <p v-if="localError" class="error">{{ localError }}</p>
    <p class="hint">
      令牌只用一次。页面刷新不会丢会话（cookie 是 HttpOnly 的，默认滑动 12 小时）；
      换掉 <code>ADMIN_API_SESSION_SECRET</code> 或重启机器人即全部失效。
    </p>
  </section>
</template>
