import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

/**
 * 备份 / 恢复演练（D8-a）：上面那些用例只证明「文件被拷了」，这里证明**拷出来的东西真能恢复**。
 *
 * 演练的是**热库**现场（连接没关、WAL 里还有未 checkpoint 的提交）——这正是 `/migrate`
 * 执行前的真实形态，也是「只拷 `.db`」会踩坑的场景。
 */
describe("备份 → 恢复演练（D8-a）", () => {
  const at = new Date(2026, 8, 29, 12, 0, 0);

  /** 造一个「已 checkpoint 一行 + WAL 里还压着新行」的热库。 */
  function makeHotDatabase(source: string): DatabaseSync {
    const db = new DatabaseSync(source);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)");
    db.exec("INSERT INTO t (id, note) VALUES (1, '已落盘')");
    // 强制把上面这次提交并进主库文件，再写一行 —— 新行只存在于 WAL 里
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("INSERT INTO t (id, note) VALUES (2, '还在 WAL 里')");
    return db;
  }

  it("热库备份后把原库删掉，用备份（.db + -wal）恢复能拿回全部数据", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-restore-"));
    const source = join(dir, "qq-group-ops.db");
    try {
      const db = makeHotDatabase(source);
      // 连接保持打开：WAL / SHM 还在，这就是备份的真实现场
      const backup = backupSqliteDatabase(source, at);
      db.close();

      expect(backup.ok).toBe(true);
      const backupPath = backup.path!;
      expect(existsSync(backupPath)).toBe(true);
      expect(existsSync(`${backupPath}-wal`)).toBe(true);

      // 灾难：原库连 WAL / SHM 一起没了
      rmSync(source, { force: true });
      rmSync(`${source}-wal`, { force: true });
      rmSync(`${source}-shm`, { force: true });

      // 恢复：把备份原样拷回去（OPERATIONS.md 的备份 / 恢复一节就是这个动作）
      cpSync(backupPath, source);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${backupPath}${suffix}`)) {
          cpSync(`${backupPath}${suffix}`, `${source}${suffix}`);
        }
      }

      const restored = new DatabaseSync(source);
      expect(restored.prepare("SELECT id, note FROM t ORDER BY id").all()).toEqual([
        { id: 1, note: "已落盘" },
        { id: 2, note: "还在 WAL 里" },
      ]);
      expect(restored.prepare("PRAGMA integrity_check").get()).toMatchObject({
        integrity_check: "ok",
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("只拷 .db 会丢掉还在 WAL 里的提交（所以 -wal 必须一起拷）", () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-restore-"));
    const source = join(dir, "qq-group-ops.db");
    try {
      const db = makeHotDatabase(source);
      const backup = backupSqliteDatabase(source, at);
      db.close();
      expect(backup.ok).toBe(true);

      // 把备份的 .db **单独**放到一个干净目录：身边没有 -wal，等于「只拷了 .db」
      const soloDir = join(dir, "solo");
      mkdirSync(soloDir, { recursive: true });
      const solo = join(soloDir, "solo.db");
      cpSync(backup.path!, solo);

      const opened = new DatabaseSync(solo);
      expect(opened.prepare("SELECT id FROM t ORDER BY id").all()).toEqual([
        { id: 1 },
      ]);
      opened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
