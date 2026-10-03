<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  adminApi,
  type AdminApiHealthView,
  type AdminApiStatus,
  type AdminApiTasksView,
  type AdminApiTokensView,
} from "@/api/admin";
import { ApiError } from "@/api/client";
import EntityLabel from "@/components/EntityLabel.vue";
import ModalDialog from "@/components/ModalDialog.vue";
import { useSessionStore } from "@/stores/session";

/**
 * 状态看板（E2-c / 运维面）：`GET /api/status` + 周期任务监测 `GET /api/tasks` +
 * 运维只读 `GET /api/health` + 登录令牌 `GET /api/tokens`。
 *
 * 平台级信息，服务端要**平台超管 240**（见 docs/ADMIN-API.md 的 E1-g），
 * 所以非超管这里只显示一句说明、连请求都不发。
 */
const session = useSessionStore();
const status = ref<AdminApiStatus | null>(null);
const tasks = ref<AdminApiTasksView | null>(null);
const health = ref<AdminApiHealthView | null>(null);
const loading = ref(false);
const error = ref("");
/** 正在重试加载的模块 key（空 = 没有请求在跑，按钮全可用）。 */
const retrying = ref("");
/** 上一次「重试加载」的结果（成功 / 仍失败都显示服务端给的原话）。 */
const retryNotice = ref<{ ok: boolean; text: string } | null>(null);

// —— 登录令牌（只读 + 吊销，平台超管 240）
const tokens = ref<AdminApiTokensView | null>(null);
/** 待确认吊销的那一行（弹窗期间保持）。 */
const pendingRevoke = ref<AdminApiTokensView["items"][number] | null>(null);
const revoking = ref(false);
const tokenNotice = ref<{ ok: boolean; text: string } | null>(null);

const allowed = computed(() => session.isSuperAdmin);

/** 只读巡检模式（`pnpm admin:api`）没有调度器与内存态：那两个端点回 503，不该把整页打成错误。 */
function nullOnUnavailable(err: unknown): null {
  if (err instanceof ApiError && err.status === 503) {
    return null;
  }
  throw err;
}

async function load(): Promise<void> {
  if (!allowed.value) {
    return;
  }
  loading.value = true;
  try {
    const [next, nextTasks, nextHealth, nextTokens] = await Promise.all([
      adminApi.status(),
      adminApi.tasks().catch(nullOnUnavailable),
      adminApi.health().catch(nullOnUnavailable),
      adminApi.tokens().catch(nullOnUnavailable),
    ]);
    status.value = next;
    tasks.value = nextTasks;
    health.value = nextHealth;
    tokens.value = nextTokens;
    error.value = "";
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 只刷令牌表（吊销后调一次；不复用 `load()`，免得把整页打成 loading）。 */
async function reloadTokens(): Promise<void> {
  try {
    tokens.value = await adminApi.tokens().catch(nullOnUnavailable);
  } catch (err) {
    tokenNotice.value = {
      ok: false,
      text: err instanceof ApiError ? err.message : String(err),
    };
  }
}

/**
 * 确认吊销某成员手上全部**未用**的登录令牌（平台超管 240）。
 *
 * 只作用于还没兑换的登录链接：已经建立的会话是签名 cookie，不受影响（弹窗与回执都写明）。
 */
async function confirmRevoke(): Promise<void> {
  const target = pendingRevoke.value;
  if (!target) {
    return;
  }
  revoking.value = true;
  try {
    const response = await adminApi.revokeTokens(target.userId);
    tokenNotice.value = {
      ok: response.result.revoked > 0,
      text: response.result.message,
    };
    await reloadTokens();
  } catch (err) {
    tokenNotice.value = {
      ok: false,
      text: err instanceof ApiError ? err.message : String(err),
    };
  } finally {
    revoking.value = false;
    pendingRevoke.value = null;
  }
}

onMounted(load);

/**
 * 重试加载一个降级模块（平台超管 240）。
 *
 * 与机器人 `/status proc` 的「重试加载」是**同一个领域入口**（幂等，只重跑该模块的 `load()`）。
 * 重试后模块状态会变（恢复 / 原因更新），周期任务的「降级跳过」也跟着变 → 两处一起刷新。
 */
async function retryModule(key: string): Promise<void> {
  if (retrying.value.length > 0) {
    return;
  }
  retrying.value = key;
  retryNotice.value = null;
  try {
    const response = await adminApi.retryModule(key);
    retryNotice.value = {
      ok: response.result.recovered,
      text: response.result.message,
    };
    const [nextHealth, nextTasks] = await Promise.all([
      adminApi.health().catch(nullOnUnavailable),
      adminApi.tasks().catch(nullOnUnavailable),
    ]);
    health.value = nextHealth;
    tasks.value = nextTasks;
  } catch (err) {
    retryNotice.value = {
      ok: false,
      text: err instanceof ApiError ? err.message : String(err),
    };
  } finally {
    retrying.value = "";
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [
    days > 0 ? `${days} 天` : "",
    hours > 0 ? `${hours} 小时` : "",
    `${minutes} 分钟`,
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

function formatTime(value: string | undefined): string {
  if (value === undefined) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * 任务节拍：`0` = 每轮都跑（跟统一扫描周期同频），否则换算成秒/分/小时。
 * 全项目只有一个定时器，每个任务只是「到点才真的执行」。
 */
function cadence(minIntervalMs: number, scanIntervalMs: number): string {
  if (minIntervalMs <= 0) {
    return `每轮（${Math.round(scanIntervalMs / 1000)} 秒）`;
  }
  if (minIntervalMs % 3_600_000 === 0) {
    return `${minIntervalMs / 3_600_000} 小时`;
  }
  if (minIntervalMs % 60_000 === 0) {
    return `${minIntervalMs / 60_000} 分钟`;
  }
  return `${Math.round(minIntervalMs / 1000)} 秒`;
}

/** 字节数 → `128.0 MB` / `1.25 GB`（与机器人 `/status proc` 同一套写法）。 */
function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}
</script>

<template>
  <section class="card">
    <h1>状态</h1>

    <p v-if="!allowed" class="hint">
      需要平台超级管理员（240）才能查看运行状态。
    </p>
    <template v-else>
      <p v-if="loading" class="hint">加载中…</p>
      <p v-if="error" class="error">{{ error }}</p>
      <dl v-if="status" class="facts">
        <dt>版本</dt>
        <dd><code>{{ status.version }}</code></dd>
        <dt>运行时长</dt>
        <dd>{{ formatUptime(status.uptimeMs) }}</dd>
        <dt>数据库</dt>
        <dd><code>{{ status.database }}</code></dd>
        <dt>迁移问题</dt>
        <dd>
          <span v-if="status.migrationIssues === 0">无</span>
          <span v-else class="error">
            {{ status.migrationIssues }} 条（详情在机器人的 `/status proc`）
          </span>
        </dd>
        <dt>未用登录令牌</dt>
        <dd>{{ status.activeTokens }} 张</dd>
        <dt>管理后台会话</dt>
        <dd>{{ status.sessions }} 个（重启机器人即全部失效）</dd>
      </dl>

      <template v-if="tasks">
        <h2 class="section-title">周期任务监测</h2>
        <p class="hint">
          统一扫描周期 <b>{{ tasks.intervalMs }} ms</b>
          （<code>SCAN_INTERVAL_MS</code>，{{ tasks.started ? "调度器运行中" : "调度器已停：周期任务全部不跑" }}）。
          保留清理 / 活动提醒 / 申诉轮转 / 待审批 TTL / 部署监测都挂在这一个节拍上；
          「降级」= 依赖的模块不可用，那一轮整轮跳过（模块恢复后立刻补跑）。
        </p>
        <table class="table">
          <thead>
            <tr>
              <th>任务</th>
              <th>节拍</th>
              <th>状态</th>
              <th>上次执行</th>
              <th>下次最早</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in tasks.tasks" :key="task.name">
              <td><code>{{ task.name }}</code></td>
              <td>{{ cadence(task.minIntervalMs, tasks.intervalMs) }}</td>
              <td>
                <span v-if="!task.enabled" class="badge">降级跳过</span>
                <span v-else-if="!tasks.started" class="hint">已停</span>
                <span v-else>正常</span>
              </td>
              <td class="nowrap">{{ formatTime(task.lastRunAt) }}</td>
              <td class="nowrap">{{ formatTime(task.nextRunAt) }}</td>
            </tr>
          </tbody>
        </table>

        <template v-if="tasks.deploy">
          <h3 class="row-title">待生效的部署</h3>
          <dl class="facts">
            <dt>目标版本</dt>
            <dd><code>v{{ tasks.deploy.targetVersion }}</code>（服务器上已就绪）</dd>
            <dt>当前运行</dt>
            <dd><code>v{{ tasks.deploy.currentVersion }}</code></dd>
            <dt>检测时间</dt>
            <dd>{{ formatTime(tasks.deploy.detectedAt) }}</dd>
            <dt>计划重启</dt>
            <dd>{{ formatTime(tasks.deploy.deadlineAt) }}</dd>
          </dl>
        </template>
      </template>
      <p v-else-if="status && !loading" class="hint">
        本进程没有周期任务调度器（只读巡检模式）：周期任务监测只在机器人进程内那口有。
      </p>

      <!-- 运维只读：把 `/status proc` 的内容搬进来（进程 / 写队列 / 模块健康 / 恢复现场） -->
      <template v-if="health">
        <h2 class="section-title">运维与恢复现场</h2>

        <dl class="facts">
          <dt>运行版本</dt>
          <dd>
            <code>v{{ health.process.runningVersion }}</code>
            <!-- 磁盘版本更新但还没重启时，这两个值会不一样 —— 正是「有新版待重启」的信号 -->
            <span v-if="health.process.diskVersion !== health.process.runningVersion">
              <span class="badge">磁盘已是 v{{ health.process.diskVersion }}（待重启生效）</span>
            </span>
          </dd>
          <dt>已运行</dt>
          <dd>
            {{ formatUptime(health.process.uptimeMs) }} · 启动于
            {{ formatTime(health.process.startedAt) }}
          </dd>
          <dt>运行环境</dt>
          <dd>
            <code>{{ health.process.node }}</code> ·
            {{ health.process.platform }}/{{ health.process.arch }} · pid
            {{ health.process.pid }} · 模式 <code>{{ health.process.mode }}</code>
          </dd>
          <dt>内存</dt>
          <dd>
            {{ formatBytes(health.process.rss) }}（堆
            {{ formatBytes(health.process.heapUsed) }} /
            {{ formatBytes(health.process.heapTotal) }}）
          </dd>
          <dt>写队列</dt>
          <dd>
            {{ health.queue.pending }} 条待写 · {{ health.queue.failures }} 条失败
            <span v-if="health.queue.lastError" class="error">
              · 最近错误：{{ health.queue.lastError }}
            </span>
          </dd>
          <dt>数据库</dt>
          <dd><code>{{ health.database.driver }}</code></dd>
          <dt>通知</dt>
          <dd>
            订阅 {{ health.notify.subscribers }} 人 · 投递记录
            {{ health.notify.deliveries }} 条
          </dd>
        </dl>

        <h3 class="row-title">模块健康</h3>
        <p v-if="health.modules.length === 0" class="hint">没有可展示的模块状态。</p>
        <table v-else id="health-modules" class="table">
          <thead>
            <tr>
              <th>模块</th>
              <th>状态</th>
              <th>错误</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="module in health.modules" :key="module.key">
              <td><code>{{ module.key }}</code> {{ module.label }}</td>
              <td>
                <span v-if="module.state === 'ready'">正常</span>
                <span v-else class="badge">{{ module.state }}</span>
              </td>
              <td class="reason">
                <span v-if="module.error" class="error">{{ module.error }}</span>
                <span v-else>—</span>
              </td>
              <td>
                <button
                  type="button"
                  class="link"
                  :disabled="module.state === 'ready' || retrying.length > 0"
                  @click="retryModule(module.key)"
                >
                  {{ retrying === module.key ? "重试中…" : "重试加载" }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p
          v-if="retryNotice"
          id="module-retry-notice"
          :class="retryNotice.ok ? 'hint' : 'error'"
        >
          {{ retryNotice.text }}
        </p>
        <p class="hint">
          模块降级后它负责的功能会停用（那一轮周期任务也会被整轮跳过）；
          修好数据 / 环境后点「重试加载」就能恢复该功能域，<b>不用重启进程</b>
          （与机器人 `/status proc` 的重试加载是同一个入口，幂等）。
        </p>

        <h3 class="row-title">恢复现场</h3>
        <dl class="facts">
          <dt>最近重启失败</dt>
          <dd>
            <span v-if="health.restart.failure" class="error">
              {{ health.restart.failure.reason }}（{{ formatTime(health.restart.failure.at) }}）
            </span>
            <span v-else>无（`data/restart-failed.json` 不存在）</span>
          </dd>
          <dt>最近回滚</dt>
          <dd>
            <span v-if="health.restart.rollback">
              {{ health.restart.rollback.reason }}（{{ formatTime(health.restart.rollback.at) }}）
            </span>
            <span v-else>无（`data/rollback-notice.json` 不存在）</span>
          </dd>
          <dt>坏构建留证</dt>
          <dd>
            <span v-if="health.restart.brokenBuild" class="badge">
              存在 data/dist-broken（历史上换过一次坏构建）
            </span>
            <span v-else>无</span>
          </dd>
        </dl>
      </template>
      <p v-else-if="status && !loading" class="hint">
        本进程没有运行时状态（只读巡检模式）：运维区块只在机器人进程内那口有。
      </p>

      <!-- 登录令牌（只读 + 吊销，平台超管 240）：回答「我发的登录链接还能不能被用掉」 -->
      <template v-if="tokens">
        <h2 class="section-title">登录令牌</h2>
        <p class="hint">
          <code>/admin login</code> 发出去的链接是<b>一次性</b>的（默认 10 分钟过期）。
          这里能看到<b>谁手上还有没用的链接</b>（按成员聚合，不显示任何哈希），发错人时立刻吊销 ——
          <b>已经登录的会话是签名 cookie，不受影响</b>。`.env` 里的机器令牌只报把数与 scope，
          要吊销得登服务器改 <code>ADMIN_API_TOKENS</code>。
        </p>
        <p v-if="tokenNotice" :class="tokenNotice.ok ? 'hint' : 'error'">
          {{ tokenNotice.text }}
        </p>
        <p v-if="tokens.items.length === 0" class="hint">
          现在没有人手上留着未用的登录链接（共 {{ tokens.total }} 张）。
        </p>
        <table v-else id="admin-tokens" class="table">
          <thead>
            <tr>
              <th>成员</th>
              <th>未用令牌</th>
              <th>最早签发</th>
              <th>最晚到期</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in tokens.items" :key="item.userId">
              <td><EntityLabel :entity="item.user" :fallback="item.userId" /></td>
              <td>{{ item.count }} 张</td>
              <td class="nowrap">{{ formatTime(item.createdAt) }}</td>
              <td class="nowrap">{{ formatTime(item.expiresAt) }}</td>
              <td>
                <button
                  type="button"
                  class="link"
                  :disabled="revoking"
                  @click="pendingRevoke = item"
                >
                  吊销
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <h3 class="row-title">配置里的机器令牌（`ADMIN_API_TOKENS`）</h3>
        <p v-if="tokens.machine.length === 0" class="hint">
          没有配置机器令牌（`ADMIN_API_TOKENS` 未设置）。
        </p>
        <table v-else id="admin-machine-tokens" class="table">
          <thead>
            <tr>
              <th>#</th>
              <th>scope</th>
              <th>到期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(machine, index) in tokens.machine" :key="index">
              <td>{{ index + 1 }}</td>
              <td><code>{{ machine.scopes.join(" ") }}</code></td>
              <td class="nowrap">
                {{ machine.expiresAt ? formatTime(machine.expiresAt) : "不过期" }}
              </td>
            </tr>
          </tbody>
        </table>
      </template>
      <p v-else-if="status && !loading" class="hint">
        本进程没有登录令牌仓储（内存模式）：令牌列表只在接了数据库时可用。
      </p>

      <button type="button" class="link" :disabled="loading" @click="load">
        刷新
      </button>
    </template>

    <!-- 吊销登录令牌：只作用在未兑换的链接上，改完不能撤销，所以先确认 -->
    <ModalDialog
      :open="pendingRevoke !== null"
      title="确认吊销登录令牌？"
      confirm-text="确认吊销"
      :busy="revoking"
      @confirm="confirmRevoke"
      @close="pendingRevoke = null"
    >
      <p>
        会让该成员手上<b>所有还没用过的登录链接立刻失效</b>（发错人的补救，不用等 10 分钟 TTL）；
        <b>已经登录的会话不受影响</b>。
      </p>
      <p v-if="pendingRevoke" class="hint">
        <EntityLabel
          :entity="pendingRevoke.user"
          :fallback="pendingRevoke.userId"
        />
        · {{ pendingRevoke.count }} 张
      </p>
    </ModalDialog>
  </section>
</template>
