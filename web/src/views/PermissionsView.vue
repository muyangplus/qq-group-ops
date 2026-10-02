<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiPermissionGrantsView,
  type AdminApiPermissionRoleList,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { useSessionStore } from "@/stores/session";

/**
 * 权限授予 / 撤销（P3，`/perm` 的管理面）。
 *
 * 口径（docs/DECISIONS.md 的 ADR-0060）：
 * - 门槛是**平台超管 240**（与指令层 `/perm` 一致）—— 这是「权限的权限」，没有第二档；
 * - 与 `/perm` 同一个 `PermissionService`：不能撤掉最后一个超级管理员等护栏照旧；
 * - 新增一条管理面护栏：**不能撤销自己的全局超管**（点一下就把自己锁死，没有回滚入口）；
 * - 每条写都写 `admin_api:perm_grant` / `admin_api:perm_revoke` 审计，
 *   并且界面**必须二次确认**、把「改完谁失去了什么」写清楚。
 */
const session = useSessionStore();

const ROLE_OPTIONS = [
  { role: "super", label: "全局超级管理员", needsGroup: false },
  { role: "group_super", label: "本群超级管理员", needsGroup: true },
  { role: "group_admin", label: "群管理员", needsGroup: true },
  { role: "moderator", label: "审核员", needsGroup: true },
];

const view = ref<AdminApiPermissionGrantsView | null>(null);
const loading = ref(false);
const error = ref("");
const notice = ref("");
const groupFilter = ref("");
const role = ref("group_admin");
const target = ref("");
const saving = ref(false);
/** 待确认的动作（弹窗期间保持，确认后才发请求）。 */
const pending = ref<{ action: "grant" | "revoke" } | null>(null);

const allowed = computed(() => session.isSuperAdmin);
const needsGroup = computed(
  () => ROLE_OPTIONS.find((option) => option.role === role.value)?.needsGroup ?? true,
);
const selectedRoleLabel = computed(
  () => ROLE_OPTIONS.find((option) => option.role === role.value)?.label ?? role.value,
);
const targetLabel = computed(() => target.value.trim() || "（填 openid 或 QQ号）");
const scopeLabel = computed(() =>
  needsGroup.value ? session.groupLabelIn(groupFilter.value) : "全局",
);

function groupLabel(groupId: string): string {
  return session.groupLabelIn(groupId);
}

async function load(): Promise<void> {
  if (!allowed.value) {
    return;
  }
  loading.value = true;
  try {
    const result = await adminApi.permissions(
      groupFilter.value.length > 0 ? { group: groupFilter.value } : {},
    );
    view.value = result;
    // 第一次拿到列表时自动选第一个有授权的群（超管大部分时候是在管群）
    if (groupFilter.value.length === 0 && result.groups[0]) {
      groupFilter.value = result.groups[0].groupId;
      await load();
      return;
    }
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function roleListOf(roleName: string): AdminApiPermissionRoleList | undefined {
  if (roleName === "super") {
    return view.value?.global.find((item) => item.role === "super");
  }
  return view.value?.group?.roles.find((item) => item.role === roleName);
}

/** 确认弹窗里要写清楚的后果（改完这个人会多 / 少什么）。 */
const confirmText = computed(() => {
  const action = pending.value?.action;
  if (!action) {
    return "";
  }
  return action === "grant"
    ? `授予后，${targetLabel.value} 会获得「${selectedRoleLabel.value}」（${scopeLabel.value}）。`
    : `撤销后，${targetLabel.value} 会失去「${selectedRoleLabel.value}」（${scopeLabel.value}）。${
        role.value === "super"
          ? "注意：撤销全局超管会立刻失去管理后台的全部权限。"
          : ""
      }`;
});

function ask(action: "grant" | "revoke"): void {
  notice.value = "";
  error.value = "";
  if (needsGroup.value && groupFilter.value.length === 0) {
    error.value = "群角色需要先选一个群。";
    return;
  }
  if (target.value.trim().length === 0) {
    error.value = "填上目标用户的 openid 或 QQ号。";
    return;
  }
  pending.value = { action };
}

async function confirm(): Promise<void> {
  const action = pending.value?.action;
  pending.value = null;
  if (!action) {
    return;
  }
  saving.value = true;
  try {
    const result = await adminApi.setPermission({
      action,
      role: role.value,
      ...(needsGroup.value ? { group: groupFilter.value } : {}),
      userId: target.value.trim(),
    });
    notice.value = result.message;
    target.value = "";
    await load();
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h1>权限</h1>
    <p class="hint">
      门槛：平台超管（240）—— 改的是判定权限的那张表，所以只有这一档、每条都写审计。
      与机器人里的 <code>/perm</code> 同一份数据；不能撤销自己的全局超管
      （点一下就没人能改回来了），更不能撤掉最后一个超管。
    </p>

    <p v-if="!allowed" class="hint">需要平台超管（240）才能看这个页面。</p>

    <template v-else>
      <div class="toolbar">
        <label for="perm-group">群</label>
        <select id="perm-group" v-model="groupFilter" @change="load">
          <option value="">（只看全局超管）</option>
          <option
            v-for="item in view?.groups ?? []"
            :key="item.groupId"
            :value="item.groupId"
          >
            {{ groupLabel(item.groupId) }}
          </option>
        </select>
        <button type="button" class="link" :disabled="loading" @click="load">刷新</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <p v-if="notice" class="ok">{{ notice }}</p>

      <div class="section-title">授予 / 撤销</div>
      <div class="toolbar">
        <label for="perm-role">角色</label>
        <select id="perm-role" v-model="role">
          <option v-for="option in ROLE_OPTIONS" :key="option.role" :value="option.role">
            {{ option.label }}
          </option>
        </select>
        <label for="perm-target">目标</label>
        <input
          id="perm-target"
          v-model="target"
          placeholder="openid 或 QQ号"
          title="与 /perm 一样接受 openid / 已绑定的 QQ号"
        />
        <button type="button" :disabled="saving" @click="ask('grant')">授予</button>
        <button type="button" class="danger" :disabled="saving" @click="ask('revoke')">
          撤销
        </button>
        <span class="hint">
          {{ needsGroup ? `范围：${scopeLabel}` : "范围：全局（不需要群）" }}
        </span>
      </div>

      <template v-if="view">
        <div class="section-title">全局超级管理员</div>
        <ul class="chips">
          <li v-for="member in roleListOf('super')?.members ?? []" :key="member.userId">
            <EntityLabel :entity="member.user" :fallback="member.userId" :details="false" />
          </li>
        </ul>

        <template v-if="view.group">
          <div class="section-title">
            群内角色（<EntityLabel :entity="view.group.group" :fallback="groupFilter" />）
          </div>
          <table class="table">
            <thead>
              <tr>
                <th>角色</th>
                <th>成员</th>
                <th>人数</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="list in view.group.roles" :key="list.role">
                <td>{{ list.roleLabel }}</td>
                <td>
                  <span v-if="list.members.length === 0" class="hint">（没有人）</span>
                  <template v-for="member in list.members" :key="member.userId">
                    <EntityLabel
                      :entity="member.user"
                      :fallback="member.userId"
                      :details="false"
                    />
                    <span class="hint"> </span>
                  </template>
                </td>
                <td>{{ list.members.length }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </template>
    </template>

    <ModalDialog
      :open="pending !== null"
      title="确认改权限？"
      :confirm-text="pending?.action === 'revoke' ? '确认撤销' : '确认授予'"
      :danger="pending?.action === 'revoke'"
      :busy="saving"
      @close="pending = null"
      @confirm="confirm"
    >
      <p>{{ confirmText }}</p>
    </ModalDialog>
  </section>
</template>
