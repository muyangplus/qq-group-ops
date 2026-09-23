import type { Settings } from "./config.js";
import { getLogger } from "./core/logger.js";
import {
  SqlActivityRepository,
  type ActivityRepository,
} from "./db/activityRepository.js";
import {
  SqlAuditRepository,
  type AuditRepository,
} from "./db/auditRepository.js";
import {
  SqlGroupConfigRepository,
  type GroupConfigRepository,
} from "./db/groupConfigRepository.js";
import {
  SqlGroupSettingsRepository,
  type GroupSettingsRepository,
} from "./db/groupSettingsRepository.js";
import {
  SqlGroupMessageModeRepository,
  type GroupMessageModeRepository,
} from "./db/groupMessageModeRepository.js";
import {
  SqlIdentityBindingRepository,
  type IdentityBindingRepository,
} from "./db/identityBindingRepository.js";
import {
  SqlJoinRequestRepository,
  type JoinRequestRepository,
} from "./db/joinRequestRepository.js";
import { migrate } from "./db/migrate.js";
import {
  SqlPermissionRepository,
  type PermissionRepository,
} from "./db/permissionRepository.js";
import { PgQueryable, type PgPoolLike } from "./db/pgQueryable.js";
import type { Queryable } from "./db/queryable.js";
import { openSqliteDatabase } from "./db/sqliteDatabase.js";
import { SqliteQueryable } from "./db/sqliteQueryable.js";

export interface PersistencePool extends PgPoolLike {
  end(): Promise<void>;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export interface Persistence {
  driver: "sqlite" | "postgres";
  audit: AuditRepository;
  joinRequests: JoinRequestRepository;
  groupConfigs: GroupConfigRepository;
  groupSettings: GroupSettingsRepository;
  identityBindings: IdentityBindingRepository;
  groupMessageModes: GroupMessageModeRepository;
  permissions: PermissionRepository;
  activities: ActivityRepository;
  close(): Promise<void>;
}

export interface PersistenceOptions {
  /** 仅测试使用：注入 PostgreSQL 连接池。 */
  createPool?: (
    connectionString: string,
  ) => PersistencePool | Promise<PersistencePool>;
}

/**
 * 连接数据库并执行迁移。
 *
 * 默认使用 SQLite 文件；`DATABASE_URL` 为 `postgres://` 时使用 PostgreSQL；
 * 显式配置为 `memory` 时返回 `undefined`，运行时退化为纯内存模式。
 * 数据库无法打开或迁移失败时抛错，避免“以为持久化了其实没有”的静默降级。
 */
export async function connectPersistence(
  settings: Settings,
  options: PersistenceOptions = {},
): Promise<Persistence | undefined> {
  const log = getLogger("persistence");
  const target = settings.databaseTarget;

  if (target.driver === "memory") {
    log.warn("内存模式：所有状态只保存在内存中，进程重启后会丢失。");
    return undefined;
  }

  if (target.driver === "sqlite") {
    const db = await openSqliteDatabase(target.path).catch((error: unknown) => {
      throw new Error(
        `无法打开 SQLite 数据库（${target.path}）：${formatError(error)}`,
      );
    });
    const queryable = new SqliteQueryable(db);
    try {
      await migrate(queryable);
    } catch (error) {
      db.close();
      throw new Error(
        `无法初始化 SQLite schema（${target.path}）：${formatError(error)}`,
      );
    }
    log.info("sqlite database ready", { path: target.path });
    return {
      driver: "sqlite",
      ...createRepositories(queryable),
      close: async () => {
        db.close();
      },
    };
  }

  const createPool = options.createPool ?? createPgPool;
  const pool = await createPool(target.url);
  pool.on?.("error", (error) => {
    log.error("postgres pool error", { error: error.message });
  });

  const db = new PgQueryable(pool);
  try {
    await migrate(db);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(
      "无法连接或初始化 PostgreSQL：" +
        `${formatError(error)}\n` +
        "请确认数据库已启动（pnpm db:up），" +
        "或在 .env 中清空 DATABASE_URL 以使用默认的 SQLite。",
    );
  }

  log.info("postgres database ready");
  return {
    driver: "postgres",
    ...createRepositories(db),
    close: async () => {
      await pool.end();
    },
  };
}

interface RepositorySet {
  audit: AuditRepository;
  joinRequests: JoinRequestRepository;
  groupConfigs: GroupConfigRepository;
  groupSettings: GroupSettingsRepository;
  identityBindings: IdentityBindingRepository;
  groupMessageModes: GroupMessageModeRepository;
  permissions: PermissionRepository;
  activities: ActivityRepository;
}

function createRepositories(db: Queryable): RepositorySet {
  return {
    audit: new SqlAuditRepository(db),
    joinRequests: new SqlJoinRequestRepository(db),
    groupConfigs: new SqlGroupConfigRepository(db),
    groupSettings: new SqlGroupSettingsRepository(db),
    identityBindings: new SqlIdentityBindingRepository(db),
    groupMessageModes: new SqlGroupMessageModeRepository(db),
    permissions: new SqlPermissionRepository(db),
    activities: new SqlActivityRepository(db),
  };
}

async function createPgPool(connectionString: string): Promise<PersistencePool> {
  let Pool: typeof import("pg").Pool;
  try {
    ({ Pool } = await import("pg"));
  } catch (error) {
    throw new Error("PostgreSQL 支持需要安装 pg 依赖：pnpm add pg", {
      cause: error,
    });
  }
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
  });
  return pool as unknown as PersistencePool;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
