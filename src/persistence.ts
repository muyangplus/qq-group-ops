import { Pool } from "pg";

import type { Settings } from "./config.js";
import { getLogger } from "./core/logger.js";
import {
  PostgresIdentityBindingRepository,
  type IdentityBindingRepository,
} from "./db/identityBindingRepository.js";
import { migrate } from "./db/migrate.js";
import { PgQueryable, type PgPoolLike } from "./db/pgQueryable.js";

export interface PersistencePool extends PgPoolLike {
  end(): Promise<void>;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export interface Persistence {
  identityBindings: IdentityBindingRepository;
  close(): Promise<void>;
}

export interface PersistenceOptions {
  createPool?: (connectionString: string) => PersistencePool;
}

/**
 * 连接 PostgreSQL 并执行迁移。
 *
 * - `DATABASE_URL` 未配置（或为空）时返回 `undefined`，运行时退化为纯内存模式；
 * - 已配置但连接/迁移失败时抛错，避免“以为持久化了其实没有”的静默降级。
 */
export async function connectPersistence(
  settings: Settings,
  options: PersistenceOptions = {},
): Promise<Persistence | undefined> {
  const log = getLogger("persistence");
  if (!settings.databaseConfigured) {
    log.warn(
      "DATABASE_URL 未配置：绑定关系只保存在内存中，进程重启后会丢失。",
    );
    return undefined;
  }

  const createPool = options.createPool ?? createPgPool;
  const pool = createPool(settings.databaseUrl);
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
        "请确认数据库已启动（例如 docker compose up -d db），" +
        "或在 .env 中清空 DATABASE_URL 以使用内存模式（绑定关系重启后会丢失）。",
    );
  }

  log.info("database schema ready");
  return {
    identityBindings: new PostgresIdentityBindingRepository(db),
    close: async () => {
      await pool.end();
    },
  };
}

function createPgPool(connectionString: string): PersistencePool {
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
