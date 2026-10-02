<script setup lang="ts">
import { computed } from "vue";

import type { AdminApiEntityRef } from "@/api/admin";
import { entityDetailRows, entityLabel } from "@/lib/entity";

/**
 * 实体展示（E2-e）：正文用「人念得出来的名字」（群号 / QQ号 → 短码），
 * 完整的官方长码收进折叠的「详情」里 —— 列表不再被 32 位十六进制撑坏，
 * 需要精确 id（提 issue / 手工调接口）时展开就有。
 */
const props = withDefaults(
  defineProps<{
    /**
     * 后端给的展示信息；缺省时用 `fallback` 原文显示。
     *
     * 属性名叫 `entity` 而不是 `ref`：`ref` 与 `key` 是 Vue 的**保留属性**，组件上声明
     * 名为 `ref` 的 prop 永远拿不到值（父组件写 `:ref="x"` 会被编译成 vnode.ref）。
     */
    entity?: AdminApiEntityRef | undefined;
    /** 缺省 / 老响应时的兜底文本（一般是原始 id）。 */
    fallback: string;
    /** 前缀，例如「群」→「群 50001」。 */
    prefix?: string;
    /** 正文后面是否附一个可折叠的「详情」。 */
    details?: boolean;
  }>(),
  { prefix: "", details: true },
);

const label = computed(() => entityLabel(props.entity, props.fallback));
const rows = computed(() =>
  props.entity
    ? entityDetailRows(props.entity)
    : [{ label: "ID", value: props.fallback, mono: true }],
);
/** 详情只有一行且和正文一模一样时就不必折叠了（例如只有短码的场景）。 */
const showDetails = computed(
  () =>
    props.details &&
    (rows.value.length > 1 || rows.value[0]?.value !== label.value),
);
</script>

<template>
  <span class="entity">
    <span class="entity-label">{{ prefix }}{{ label }}</span>
    <details v-if="showDetails" class="entity-details">
      <summary>详情</summary>
      <dl>
        <template v-for="row in rows" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd :class="{ mono: row.mono }">{{ row.value || "—" }}</dd>
        </template>
      </dl>
    </details>
  </span>
</template>
