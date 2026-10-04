import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeBuildInfo } from "../src/core/buildInfo.js";
import {
  DeployInstaller,
  PACKAGE_ARCHIVE_DIR,
  PACKAGE_UNPACK_DIR,
  extractTarGz,
  readDeployState,
  trimArchive,
  trimIncoming,
  type InstallNotice,
} from "../src/services/deployInstaller.js";

/**
 * 机器人自解产物包（ADR-0065 第 2、3 条）。
 *
 * 关注点：sha256 防半传（同一份坏包只私信一次、坏包改名留证）、指纹自证、
 * **整目录替换**（`data/` `.env` `logs/` 绝不碰、不留混装）、失败还原、
 * `incoming/` 与 `data/packages/` 只留最近 3 个、以及「回滚 = 重新应用上一个包」。
 */

// ------------------------------------------------------------------ 手工打包 tar.gz

interface TarEntry {
  name: string;
  content?: string;
}

function writeOctal(buffer: Buffer, start: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  buffer.write(text.slice(0, length - 1), start, length - 1, "ascii");
  buffer.write("\0", start + length - 1, 1, "ascii");
}

/**
 * 极简 tar 写入（只用到最普通的那几种头 —— 正是 GNU/BSD tar 的默认输出）。
 *
 * 自己做而不是调系统 `tar`：产物环境里不一定有 `tar`（Windows 开发机 / 精简容器），
 * 而部署这一步必须在任何环境都能跑。
 */
function makeTarGz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.content ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("000644 \0", 100, 8, "utf8");
    header.write("000000 \0", 108, 8, "utf8");
    header.write("000000 \0", 116, 8, "utf8");
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.write("        ", 148, 8, "utf8");
    header.write("0", 156, 1, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    writeOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    blocks.push(header);
    if (body.length > 0) {
      blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** 一份「构建好的产物」：`dist/` 三个关键词文件 + `web/dist/` + `scripts/`。 */
function buildFiles(marker: string): Record<string, string> {
  return {
    "dist/main.js": `main-${marker}\n`,
    "dist/adminApi/backend.js": `boundGroupIds-${marker}\n`,
    "dist/services/platformSettings.js": `定时发言总开关-${marker}\n`,
    "web/dist/index.html": `<html>${marker}</html>\n`,
    "scripts/classIndex.mjs": `// ${marker}\n`,
  };
}

/** 把文件表打成 `.tar.gz`，`dist/build-info.json` 由 `writeBuildInfo` 一致地生成。 */
function packTgz(files: Record<string, string>, version: string, commit = "c0ffee"): Buffer {
  const staging = mkdtempSync(join(tmpdir(), "qqops-pack-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(staging, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    writeBuildInfo({ version, commit, dir: join(staging, "dist") });
    const entries: TarEntry[] = Object.entries(files).map(([name, content]) => ({
      name,
      content,
    }));
    entries.push({
      name: "dist/build-info.json",
      content: readFileSync(join(staging, "dist", "build-info.json"), "utf8"),
    });
    return makeTarGz(entries);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 从 tar.gz 里读 `dist/build-info.json` 的指纹（投递标记里要写同一个值）。 */
function fingerprintOfArchive(tgz: Buffer): string {
  const staging = mkdtempSync(join(tmpdir(), "qqops-probe-"));
  try {
    extractTarGz(tgz, staging);
    const parsed = JSON.parse(
      readFileSync(join(staging, "dist/build-info.json"), "utf8"),
    ) as { distFingerprint?: string };
    return parsed.distFingerprint ?? "";
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ 夹具

interface DeliverOptions {
  sha256?: string;
  tgz?: Buffer;
  meta?: Partial<Record<string, string>>;
}

interface Harness {
  root: string;
  incoming: string;
  archiveDir: string;
  stateFile: string;
  workDir: string;
  installer: DeployInstaller;
  notices: Array<{ userId: string; card: InstallNotice }>;
  restarts: Array<{ requestedBy: string; reason: string; targetVersion: string }>;
  setAccept: (value: boolean) => void;
  deliver: (version: string, files: Record<string, string>, options?: DeliverOptions) => string;
  /** 按应用根读取文件（断言「产物真的换了 / `data/` 真的没动」）。 */
  at: (path: string) => string;
}

/** 固定时钟：回执与 `*.failed-<ts>` 的时间戳可断言，保留策略的 mtime 比较也可复现。 */
const CLOCK = Date.parse("2026-10-04T12:00:00.000Z");

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "qqops-installer-"));
  const incoming = join(root, "incoming");
  const archiveDir = join(root, PACKAGE_ARCHIVE_DIR);
  const workDir = join(root, PACKAGE_UNPACK_DIR);
  const stateFile = join(root, "data/deploy-state.json");
  // 应用现场的既有内容：data/、.env、logs/ 都在，且**不该被碰**
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(join(root, ".env"), "KEEP=1\n", "utf8");
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/main.js"), "old-main\n", "utf8");
  // 覆盖式还原会留下来的文件：整目录替换后它必须消失
  writeFileSync(join(root, "dist/stale.js"), "must-be-gone\n", "utf8");
  // CD 的同步状态：机器人动过 dist 之后必须被自己作废
  writeFileSync(join(root, "ftp-sync-state-code.json"), "{}", "utf8");
  writeFileSync(join(root, "ftp-sync-state-marker.json"), "{}", "utf8");

  const notices: Array<{ userId: string; card: InstallNotice }> = [];
  const restarts: Array<{ requestedBy: string; reason: string; targetVersion: string }> = [];
  let accept = true;

  const installer = new DeployInstaller({
    incomingDir: incoming,
    archiveDir,
    workDir,
    stateFile,
    installerReceiptFile: join(root, "data/deploy-receipt.json"),
    root,
    restart: (info) => {
      if (!accept) {
        return false;
      }
      restarts.push(info);
      return true;
    },
    notify: async (userId, card) => {
      notices.push({ userId, card });
    },
    recipients: () => ["root"],
    clock: () => CLOCK,
  });

  return {
    root,
    incoming,
    archiveDir,
    stateFile,
    workDir,
    installer,
    notices,
    restarts,
    setAccept: (value) => {
      accept = value;
    },
    at: (path) => readFileSync(join(root, path), "utf8"),
    deliver: (version, files, options = {}) => {
      mkdirSync(incoming, { recursive: true });
      const tgz = options.tgz ?? packTgz(files, version);
      writeFileSync(join(incoming, `deploy-${version}.tgz`), tgz);
      const meta = {
        version,
        commit: "c0ffee",
        // 与实现同一算法；显式再算一遍，防止「实现自己校验自己」
        sha256: options.sha256 ?? createHash("sha256").update(tgz).digest("hex"),
        distFingerprint: fingerprintOfArchive(tgz),
        builtAt: "2026-10-04T00:00:00.000Z",
        ...options.meta,
      };
      const jsonPath = join(incoming, `deploy-${version}.json`);
      writeFileSync(jsonPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
      return jsonPath;
    },
  };
}

// ------------------------------------------------------------------ 用例

describe("DeployInstaller", () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    rmSync(h.root, { recursive: true, force: true });
  });

  it("正常应用：整目录替换 + 归档 + 状态 + 回执 + 作废同步状态 + 交给重启", async () => {
    h.deliver("0.28.0", buildFiles("a"));
    const result = await h.installer.runOnce();

    expect(result?.ok).toBe(true);
    expect(result?.version).toBe("0.28.0");
    // 整目录替换：新文件在、**旧文件被清掉**（不是覆盖式还原）
    expect(h.at("dist/main.js")).toBe("main-a\n");
    expect(existsSync(join(h.root, "dist/stale.js"))).toBe(false);
    expect(h.at("web/dist/index.html")).toBe("<html>a</html>\n");
    expect(h.at("scripts/classIndex.mjs")).toBe("// a\n");
    // 绝不碰 data/ .env logs/
    expect(h.at(".env")).toBe("KEEP=1\n");
    expect(existsSync(join(h.root, "logs"))).toBe(true);
    // 包同时当备份
    expect(existsSync(join(h.archiveDir, "deploy-0.28.0.tgz"))).toBe(true);
    // 投递箱里的这份被清掉（否则下一轮还会装一次）
    expect(readdirSync(h.incoming)).toEqual([]);
    // 状态 + 回执
    expect(readDeployState(h.stateFile)).toMatchObject({
      appliedVersion: "0.28.0",
      previousVersion: "",
    });
    const receipt = JSON.parse(
      readFileSync(join(h.root, "data/deploy-receipt.json"), "utf8"),
    ) as { ok: boolean; version: string };
    expect(receipt).toMatchObject({ ok: true, version: "0.28.0" });
    // 自己动过 dist → 主动作废 FTP 同步状态（下一轮 CD 全量）
    expect(existsSync(join(h.root, "ftp-sync-state-code.json"))).toBe(false);
    expect(existsSync(join(h.root, "ftp-sync-state-marker.json"))).toBe(false);
    // 交给既有重启用例
    expect(h.restarts).toEqual([
      { requestedBy: "deploy-installer", reason: "deploy", targetVersion: "0.28.0" },
    ]);
  });

  it("sha256 不符（半传）：拒绝这次部署、私信一次、坏包改名留证、不动运行中的产物", async () => {
    h.deliver("0.28.0", buildFiles("a"), { sha256: "0".repeat(64) });
    const first = await h.installer.runOnce();

    expect(first?.ok).toBe(false);
    expect(first?.code).toBe("sha_mismatch");
    expect(h.restarts).toHaveLength(0);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.card.kind).toBe("half-transferred");
    expect(h.notices[0]?.card.lines.join("\n")).toContain("半传");

    // 坏包改名留证（`*.failed-<ts>`），同一份包不再被反复重试
    expect(readdirSync(h.incoming).some((name) => name.includes(".failed-"))).toBe(true);
    expect(await h.installer.runOnce()).toBeUndefined();
    expect(h.notices).toHaveLength(1);

    // 拒绝之后运行中的机器人不受影响、同步状态也没被动过
    expect(h.at("dist/main.js")).toBe("old-main\n");
    expect(existsSync(join(h.root, "ftp-sync-state-code.json"))).toBe(true);
  });

  it("自证不过（包内 dist 与 build-info 对不上）：拒绝并私信", async () => {
    const tgz = makeTarGz([
      { name: "dist/main.js", content: "real\n" },
      {
        name: "dist/build-info.json",
        content: JSON.stringify({
          version: "0.28.0",
          commit: "c",
          builtAt: "x",
          distFingerprint: "deadbeef",
        }),
      },
    ]);
    h.deliver("0.28.0", {}, { tgz, meta: { distFingerprint: "deadbeef" } });

    const result = await h.installer.runOnce();
    expect(result?.ok).toBe(false);
    expect(result?.code).toBe("self_check_failed");
    expect(result?.message).toContain("指纹对不上");
    expect(h.at("dist/main.js")).toBe("old-main\n");
    expect(h.notices.map((item) => item.card.kind)).toEqual(["self-check-failed"]);
  });

  it("包内版本与标记不一致：拒绝（不装来历不明的产物）", async () => {
    // 用 0.28.1 的包冒充 0.28.0 的标记
    const tgz = packTgz(buildFiles("a"), "0.28.1");
    h.deliver("0.28.0", {}, { tgz, meta: { distFingerprint: fingerprintOfArchive(tgz) } });

    const result = await h.installer.runOnce();
    expect(result?.ok).toBe(false);
    expect(result?.code).toBe("version_mismatch");
    expect(h.at("dist/main.js")).toBe("old-main\n");
  });

  it("替换失败：整体回退（不留混装），现役产物与 data/ .env 都不变", async () => {
    // 先正常应用 v0.28.0（现役产物 = 这一份）
    h.deliver("0.28.0", buildFiles("a"));
    expect((await h.installer.runOnce())?.ok).toBe(true);

    // 制造一个真实的失败面：把 `root/web` 做成**文件**，替换到 `web/dist` 时必然失败
    rmSync(join(h.root, "web"), { recursive: true, force: true });
    writeFileSync(join(h.root, "web"), "占位：本该是目录\n", "utf8");
    // 上一轮成功应用把同步状态作废了；这里重新放两份，用来断言「这次没换成 = 也不该被作废」
    writeFileSync(join(h.root, "ftp-sync-state-code.json"), "{}", "utf8");

    h.deliver("0.28.1", buildFiles("b"));
    const result = await h.installer.runOnce();

    expect(result?.ok).toBe(false);
    expect(result?.code).toBe("replace_failed");
    // **不混装**：`dist` 已经换成 b 又立刻换回来，且旧文件都还在
    expect(h.at("dist/main.js")).toBe("main-a\n");
    expect(h.at("dist/adminApi/backend.js")).toBe("boundGroupIds-a\n");
    expect(h.at("scripts/classIndex.mjs")).toBe("// a\n");
    // 没碰 data/ .env；同步状态也没被作废（这次没换成）
    expect(h.at(".env")).toBe("KEEP=1\n");
    expect(existsSync(join(h.root, "ftp-sync-state-code.json"))).toBe(true);
    // 这次替换没走成 → 不该再排一次重启（第一次成功应用那次的重启仍在记录里）
    expect(h.restarts.map((item) => item.targetVersion)).toEqual(["0.28.0"]);
    expect(h.notices.map((item) => item.card.kind)).toEqual(["replace-failed"]);
    // 没有 `.restore-*` / `.prev*` 残骸
    expect(readdirSync(h.workDir).filter((name) => name.startsWith("."))).toEqual([]);
    expect(readdirSync(h.root).filter((name) => name.includes(".prev-"))).toEqual([]);
  });

  it("归档只保留最近 3 个包", async () => {
    for (const version of ["0.28.0", "0.28.1", "0.28.2", "0.28.3"]) {
      h.deliver(version, buildFiles(version));
      expect((await h.installer.runOnce())?.ok).toBe(true);
      // 「最近」按落地时刻算：用固定的递增 mtime 明确顺序（真实时间会让断言随机）
      utimesSync(
        join(h.archiveDir, `deploy-${version}.tgz`),
        new Date(),
        new Date(Date.parse("2020-01-01T00:00:00Z") + Number(version.slice(-1)) * 1000),
      );
    }
    expect(readdirSync(h.archiveDir).sort()).toEqual([
      "deploy-0.28.1.tgz",
      "deploy-0.28.2.tgz",
      "deploy-0.28.3.tgz",
    ]);
  });

  it("incoming 只保留最近 3 个包（连对应的 .tgz 一起清）", () => {
    for (const version of ["0.28.0", "0.28.1", "0.28.2", "0.28.3"]) {
      h.deliver(version, buildFiles(version));
      utimesSync(
        join(h.incoming, `deploy-${version}.json`),
        new Date(),
        new Date(Date.parse("2020-01-01T00:00:00Z") + Number(version.slice(-1)) * 1000),
      );
    }
    trimIncoming(h.incoming);
    expect(readdirSync(h.incoming).sort()).toEqual([
      "deploy-0.28.1.json",
      "deploy-0.28.1.tgz",
      "deploy-0.28.2.json",
      "deploy-0.28.2.tgz",
      "deploy-0.28.3.json",
      "deploy-0.28.3.tgz",
    ]);
  });

  it("trimArchive 同样只留最近 3 个（按落地时刻，不看版本号）", () => {
    mkdirSync(h.archiveDir, { recursive: true });
    for (const version of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) {
      const file = join(h.archiveDir, `deploy-${version}.tgz`);
      writeFileSync(file, version);
      utimesSync(
        file,
        new Date(),
        new Date(Date.parse("2020-01-01T00:00:00Z") + Number(version.charAt(2)) * 1000),
      );
    }
    trimArchive(h.archiveDir);
    expect(readdirSync(h.archiveDir).sort()).toEqual([
      "deploy-0.2.0.tgz",
      "deploy-0.3.0.tgz",
      "deploy-0.4.0.tgz",
    ]);
  });

  it("只有标记、没有包（半传中间态）：留着等下一轮，不刷屏", async () => {
    mkdirSync(h.incoming, { recursive: true });
    writeFileSync(
      join(h.incoming, "deploy-0.28.0.json"),
      JSON.stringify({
        version: "0.28.0",
        commit: "c",
        sha256: "a".repeat(64),
        distFingerprint: "f",
        builtAt: "x",
      }),
      "utf8",
    );

    expect(await h.installer.runOnce()).toBeUndefined();
    expect(h.notices).toHaveLength(0);
    expect(readdirSync(h.incoming)).toEqual(["deploy-0.28.0.json"]);
    expect(h.at("dist/main.js")).toBe("old-main\n");
  });

  it("坏标记（JSON 坏了）：改名留证 + 私信一次", async () => {
    mkdirSync(h.incoming, { recursive: true });
    writeFileSync(join(h.incoming, "deploy-0.28.0.json"), "{不是 JSON", "utf8");

    expect(await h.installer.runOnce()).toBeUndefined();
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.card.kind).toBe("self-check-failed");
    expect(readdirSync(h.incoming).some((name) => name.includes(".failed-"))).toBe(true);
  });

  it("重启没被受理：还原上一个包并把原因私信超管", async () => {
    h.deliver("0.28.0", buildFiles("a"));
    expect((await h.installer.runOnce())?.ok).toBe(true);

    h.setAccept(false);
    h.deliver("0.28.1", buildFiles("b"));
    const result = await h.installer.runOnce();

    expect(result?.ok).toBe(false);
    expect(result?.code).toBe("restart_rejected");
    expect(result?.restoredVersion).toBe("0.28.0");
    expect(h.at("dist/main.js")).toBe("main-a\n");
    expect(h.notices.at(-1)?.card.kind).toBe("replace-failed");
  });

  it("回滚：重新应用归档里的上一个包，回执写 vX → vY", async () => {
    h.deliver("0.28.0", buildFiles("a"));
    expect((await h.installer.runOnce())?.ok).toBe(true);
    h.deliver("0.28.1", buildFiles("b"));
    expect((await h.installer.runOnce())?.ok).toBe(true);
    expect(h.at("dist/main.js")).toBe("main-b\n");
    expect(h.installer.rollbackTarget()).toMatchObject({
      version: "0.28.0",
      currentVersion: "0.28.1",
    });

    const result = await h.installer.rollback();
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.message).toContain("v0.28.1 → v0.28.0");
    expect(h.at("dist/main.js")).toBe("main-a\n");
    // 状态可以继续回滚（再点一次回到 v0.28.1）
    expect(readDeployState(h.stateFile)).toMatchObject({
      appliedVersion: "0.28.0",
      previousVersion: "0.28.1",
    });
    expect(h.installer.rollbackTarget()?.version).toBe("0.28.1");
  });

  it("没得回滚时如实说（不假装成功）", async () => {
    expect(h.installer.rollbackTarget()).toBeUndefined();
    const result = await h.installer.rollback();
    expect(result.ok).toBe(false);
    expect(result.code).toBe("no_target");
    expect(result.message).toContain("没有可回滚");
  });
});
