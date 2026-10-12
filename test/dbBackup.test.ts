import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  backupDatabase,
  backupNameFor,
  backupSqliteDatabase,
} from "../src/services/dbBackup.js";

/**
 * `/migrate` 执行前的自动备份。
 *
 * 从 ADR-0071 起首选 **`VACUUM INTO`**：单文件一致性快照（含 WAL 里还没 checkpoint 的提交），
 * 不再依赖「`.db` + `-wal` / `-shm` 一起拷」那种可能不一致的老办法。
 */
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

  it("真 SQLite 库：VACUUM INTO 出**单文件**快照，内容可读、integrity ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-backup-"));
    const source = join(dir, "qq-group-ops.db");
    try {
      const db = new DatabaseSync(source);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)");
      db.exec("INSERT INTO t (id, note) VALUES (1, 'hello')");
      db.close();

      const result = await backupSqliteDatabase(source, at);

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("vacuum");
      expect(result.path).toBe(join(dir, "qq-group-ops_20260929_114503.db"));
      const backupPath = result.path!;
      expect(existsSync(backupPath)).toBe(true);
      // 单文件：不需要 -wal / -shm 跟着走
      expect(existsSync(`${backupPath}-wal`)).toBe(false);
      expect(existsSync(`${backupPath}-shm`)).toBe(false);
      // 源库不动
      expect(existsSync(source)).toBe(true);

      const restored = new DatabaseSync(backupPath, { readOnly: true });
      expect(restored.prepare("SELECT id, note FROM t").all()).toEqual([
        { id: 1, note: "hello" },
      ]);
      expect(restored.prepare("PRAGMA integrity_check").get()).toMatchObject({
        integrity_check: "ok",
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("兜底：不是 SQLite 文件时退回文件拷贝，并如实标注「不是原子快照」", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-backup-"));
    const source = join(dir, "qq-group-ops.db");
    try {
      writeFileSync(source, "db-content", "utf8");
      writeFileSync(`${source}-wal`, "wal", "utf8");
      writeFileSync(`${source}-shm`, "shm", "utf8");

      const result = await backupSqliteDatabase(source, at);

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("copy");
      expect(result.detail).toContain("不是");
      const backupPath = result.path!;
      expect(existsSync(backupPath)).toBe(true);
      // 兜底路径仍然把 WAL / SHM 一起带走（老 SQLite 下这是唯一能保住未落盘提交的办法）
      expect(existsSync(`${backupPath}-wal`)).toBe(true);
      expect(existsSync(`${backupPath}-shm`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("数据库文件不存在时不抛错，只报告原因", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-backup-"));
    try {
      const result = await backupSqliteDatabase(join(dir, "nope.db"), at);
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("不存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PostgreSQL / 内存模式如实说明「未自动备份」", async () => {
    expect((await backupDatabase({ driver: "postgres" })).skipped).toContain(
      "pg_dump",
    );
    expect((await backupDatabase({ driver: "memory" })).skipped).toContain(
      "内存",
    );
    const dir = mkdtempSync(join(tmpdir(), "qqops-backup-"));
    try {
      const path = join(dir, "db.sqlite");
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      db.close();
      const result = await backupDatabase({ driver: "sqlite", path });
      expect(result.ok).toBe(true);
      expect(result.path).toContain("db_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 备份 / 恢复演练（D8-a）：上面那些用例只证明「文件出来了」，这里证明**备份真能恢复**。
 *
 * 演练**热库**现场（连接没关、WAL 里还有未 checkpoint 的提交）—— 这正是 `/migrate`
 * 执行前的真实形态，也是老办法「只拷 `.db`」会踩坑的场景。
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

  it("热库备份：单个文件就含 WAL 里的提交，原库删掉后拷回去能拿回全部数据", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-restore-"));
    const source = join(dir, "qq-group-ops.db");
    try {
      const db = makeHotDatabase(source);
      // 连接保持打开：WAL / SHM 还在，这就是备份的真实现场
      const backup = await backupSqliteDatabase(source, at);
      db.close();

      expect(backup.ok).toBe(true);
      expect(backup.mode).toBe("vacuum");
      const backupPath = backup.path!;
      expect(existsSync(backupPath)).toBe(true);

      // 灾难：原库连 WAL / SHM 一起没了
      rmSync(source, { force: true });
      rmSync(`${source}-wal`, { force: true });
      rmSync(`${source}-shm`, { force: true });

      // 恢复：把**这一个文件**拷回去就够（OPERATIONS.md 的备份 / 恢复一节就是这个动作）
      cpSync(backupPath, source);

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

  it("同一现场：把 VACUUM INTO 的备份**单独**放一个目录也照样完整（老办法只拷 .db 会丢）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qqops-restore-"));
    const source = join(dir, "qq-group-ops.db");
    try {
      const db = makeHotDatabase(source);
      const backup = await backupSqliteDatabase(source, at);
      db.close();
      expect(backup.ok).toBe(true);

      // 把备份**单独**放到一个干净目录：身边没有 -wal，等于最坏情况
      const soloDir = join(dir, "solo");
      mkdirSync(soloDir, { recursive: true });
      const solo = join(soloDir, "solo.db");
      cpSync(backup.path!, solo);

      const opened = new DatabaseSync(solo);
      expect(opened.prepare("SELECT id, note FROM t ORDER BY id").all()).toEqual([
        { id: 1, note: "已落盘" },
        { id: 2, note: "还在 WAL 里" },
      ]);
      opened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
