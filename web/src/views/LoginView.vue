<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

/**
 * 登录页（E2-a 先把链路跑通；E2-b 再补 401 自动跳转 / 过期提示 / 深链回跳）。
 *
 * 两种进入方式：
 * - 机器人私信里的**登录链接**：`<PUBLIC_BASE_URL>/login?token=…` → 直接兑换；
 * - 链接在 QQ 里点不动时：手工把令牌粘进输入框。
 */
const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const fromQuery = route.query["token"];
const token = ref(typeof fromQuery === "string" ? fromQuery : "");
const submitting = ref(false);
const localError = ref("");

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
    await router.replace({ name: "dashboard" });
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
