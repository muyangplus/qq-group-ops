<script setup lang="ts">
/**
 * 极简模态框（E2-c）：二次确认与「要填理由」的操作用它。
 *
 * 只用原生 `<dialog>`：无依赖、自带焦点管理与 Esc 关闭（浏览器已实现多年），
 * 比引一套弹窗组件轻得多。`autoFocus` 交给内容自己控制。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  open: boolean;
  title: string;
  /** 确认按钮文案；`danger = true` 时用危险色。 */
  confirmText?: string;
  danger?: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);

watch(
  () => props.open,
  (open) => {
    const element = dialog.value;
    if (!element) {
      return;
    }
    if (open && !element.open) {
      element.showModal();
    }
    if (!open && element.open) {
      element.close();
    }
  },
);

onMounted(() => {
  const element = dialog.value;
  if (!element) {
    return;
  }
  // Esc 关闭：`dialog` 原生会 close，这里补一次事件同步给父组件
  element.addEventListener("cancel", () => emit("close"));
});

onBeforeUnmount(() => {
  dialog.value?.close();
});
</script>

<template>
  <dialog ref="dialog" class="modal">
    <h2>{{ title }}</h2>
    <div class="modal-body">
      <slot />
    </div>
    <div class="modal-actions">
      <button type="button" class="link" :disabled="busy" @click="emit('close')">
        取消
      </button>
      <button
        type="button"
        :class="{ danger: props.danger }"
        :disabled="busy"
        @click="emit('confirm')"
      >
        {{ busy ? "处理中…" : (confirmText ?? "确认") }}
      </button>
    </div>
  </dialog>
</template>
