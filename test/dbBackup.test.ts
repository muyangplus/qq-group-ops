import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  backupDatabase,
  backupNameFor,
  backupSqliteDatabase,
} from "../src/services/dbBackup.js";

/** `/migrate` 执行前的自动备份：文件名 `{原名}_YYYYMMDD_HHMMSS`。 */
describe("dbBackup", () => {
  const at = new Date(2026, 8, 29, 11, 45, 3); // 2026-09-29 11:45:03（本地时间）

  it("文件名 = 原名 + 时间戳 + 原扩展名", () => {
    expect(backupNameFor("data/qq-group-ops.db", at)).toBe(
      "qq-group-ops_20260929_114503.db",
    );
    expect(backupNameFor("/srv/db/bot.sqlite", at)).toBe(
      "bot_20260929_114503.sqlite",
    );
  });

  it("SQLite：复制出同目录备份，WAL/SHM 一起带走", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-backup-"));
    const source = join(dir, "qq-group-ops.db");
    writeFileSync(source, "db-content", "utf8");
    writeFileSync(`${source}-wal`, "wal", "utf8");
    writeFileSync(`${source}-shm`, "shm", "utf8");
    try {
      const result = backupSqliteDatabase(source, at);
      expect(result.ok).toBe(true);
      expect(result.path).toBe(join(dir, "qq-group-ops_20260929_114503.db"));
      expect(existsSync(result.path!)).toBe(true);
      expect(existsSync(`${result.path}-wal`)).toBe(true);
      expect(existsSync(`${result.path}-shm`)).toBe(true);
      // 原库不动
      expect(existsSync(source)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("数据库文件不存在时不抛错，只报告原因", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-backup-"));
    try {
      const result = backupSqliteDatabase(join(dir, "nope.db"), at);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("不存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PostgreSQL / 内存模式如实说明「未自动备份」", () => {
    expect(backupDatabase({ driver: "postgres" }).skipped).toContain("pg_dump");
    expect(backupDatabase({ driver: "memory" }).skipped).toContain("内存");
    const dir = mkdtempSync(join(tmpdir(), "qqops-backup-"));
    try {
      const path = join(dir, "db.sqlite");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, "x", "utf8");
      const result = backupDatabase({ driver: "sqlite", path });
      expect(result.ok).toBe(true);
      expect(result.path).toContain("db_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
