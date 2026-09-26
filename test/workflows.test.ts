import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * 工作流安全审计（对应 TODO D6）。
 *
 * 只做「结构性断言」，不依赖 GitHub 的 API：
 * - 所有工作流 YAML 必须能被解析（防止手写缩进把 CI/CD 写坏）；
 * - 所有 `uses:` 必须钉在版本号上（`@v4` / `@v4.3.5`），不允许 `@main` 这类浮动分支；
 * - 禁用 `pull_request_target`（典型的提权 + secrets 泄露入口）；
 * - CD 工作流必须：最小权限、并发保护、部署前跑 typecheck/test/build、
 *   部署任务进 Environment（可配人工放行）、FTP 凭据只能来自 secrets、
 *   协议默认 FTPS、且有 `.env` / `data` 之类的排除兜底。
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");

interface WorkflowFile {
  name: string;
  text: string;
  doc: Record<string, unknown>;
}

function loadWorkflows(): WorkflowFile[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .map((name) => {
      const text = readFileSync(join(WORKFLOW_DIR, name), "utf8");
      return { name, text, doc: parse(text) as Record<string, unknown> };
    });
}

/** 收集工作流里所有 `uses:`（含嵌套 job / step）。 */
function collectUses(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUses(item, found);
    }
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "uses" && typeof item === "string") {
        found.push(item);
      } else {
        collectUses(item, found);
      }
    }
  }
  return found;
}

/** `on:` 在 YAML 1.1 里会被解析成布尔 `true`，两种键都要兼容。 */
function triggersOf(doc: Record<string, unknown>): Record<string, unknown> {
  const value = doc.on ?? doc[true as unknown as string];
  return (value ?? {}) as Record<string, unknown>;
}

function jobsOf(doc: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (doc.jobs ?? {}) as Record<string, Record<string, unknown>>;
}

function stepsOf(job: Record<string, unknown>): Array<Record<string, unknown>> {
  return (job.steps ?? []) as Array<Record<string, unknown>>;
}

function runCommands(workflow: WorkflowFile): string {
  return Object.values(jobsOf(workflow.doc))
    .flatMap((job) => stepsOf(job))
    .map((step) => (typeof step.run === "string" ? step.run : ""))
    .join("\n");
}

describe("CI/CD 工作流审计", () => {
  const workflows = loadWorkflows();
  const cdWorkflow = workflows.find((workflow) => workflow.name.startsWith("cd-"));

  it("keeps every workflow parseable with jobs and runners", () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      expect(Object.keys(triggersOf(workflow.doc)).length, workflow.name).toBeGreaterThan(0);
      const jobs = jobsOf(workflow.doc);
      expect(Object.keys(jobs).length, workflow.name).toBeGreaterThan(0);
      for (const [jobId, job] of Object.entries(jobs)) {
        // `reusable workflow` 用 `uses` 代替 runs-on，本项目不用，因此要求 runs-on
        expect(job["runs-on"], `${workflow.name}#${jobId}`).toBeDefined();
      }
    }
  });

  it("pins every action to a version tag (no floating branch)", () => {
    for (const workflow of workflows) {
      for (const use of collectUses(workflow.doc)) {
        expect(use, `${workflow.name}: ${use}`).toMatch(/@v?\d+(\.\d+)*$/u);
      }
    }
  });

  it("never uses pull_request_target", () => {
    for (const workflow of workflows) {
      expect(workflow.text, workflow.name).not.toContain("pull_request_target");
    }
  });

  it("wires the CD workflow for release-published and manual runs", () => {
    expect(cdWorkflow, "缺少 cd-*.yml 工作流").toBeDefined();
    const triggers = triggersOf(cdWorkflow!.doc);
    const release = triggers.release as { types?: string[] } | undefined;
    expect(release?.types).toContain("published");
    expect(triggers.workflow_dispatch).toBeDefined();
  });

  it("hardens the CD workflow (least privilege, concurrency, gated deploy, environment)", () => {
    const doc = cdWorkflow!.doc;
    const permissions = doc.permissions as Record<string, unknown> | undefined;
    expect(permissions?.contents).toBe("read");
    expect(doc.concurrency).toBeDefined();

    const jobs = jobsOf(doc);
    const deploy = Object.values(jobs).find((job) =>
      stepsOf(job).some((step) => String(step.uses ?? "").includes("FTP-Deploy-Action")),
    );
    expect(deploy, "找不到 FTP 部署任务").toBeDefined();
    // 部署任务必须在 build 之后，并挂在 Environment 上（可配 required reviewers）
    expect(deploy!.needs).toBeDefined();
    expect(deploy!.environment).toBeDefined();

    // 部署前门禁：类型检查 + 全量测试 + 构建
    const commands = runCommands(cdWorkflow!);
    expect(commands).toContain("pnpm typecheck");
    expect(commands).toContain("pnpm test");
    expect(commands).toContain("pnpm build");
  });

  it("keeps FTP credentials in secrets and defaults to FTPS", () => {
    const deploy = Object.values(jobsOf(cdWorkflow!.doc)).find((job) =>
      stepsOf(job).some((step) => String(step.uses ?? "").includes("FTP-Deploy-Action")),
    )!;
    const ftpStep = stepsOf(deploy).find((step) =>
      String(step.uses ?? "").includes("FTP-Deploy-Action"),
    )!;
    const withInput = (ftpStep.with ?? {}) as Record<string, string>;
    // 服务器 / 账号 / 密码都必须来自 secrets，且不能是硬编码字面量
    for (const key of ["server", "username", "password"]) {
      expect(withInput[key], key).toMatch(/^\$\{\{\s*secrets\./u);
    }
    // 默认 FTPS（显式 TLS），只在显式配置时才退回明文 ftp
    expect(withInput.protocol).toContain("ftps");
    // 只上传仓库在 CI 里重新组装的白名单目录（避免直接把仓库根传上去）
    expect(withInput["local-dir"]).toBe("./dist-deploy/");
    // 敏感文件与 sourcemap 兜底排除
    expect(withInput.exclude).toContain("**/.env");
    expect(withInput.exclude).toContain("**/data/**");
    expect(withInput.exclude).toContain("**/test/**");
    expect(withInput.exclude).toContain("**/*.map");
  });

  it("only ships the runtime artifacts to the server", () => {
    const commands = runCommands(cdWorkflow!);
    // 组包白名单就是「运行产物」这一份清单：多一个都算回归（源码/文档/构建配置不上服务器）
    const match = /for item in ([^;]+);/u.exec(commands);
    expect(match, "找不到组包白名单").not.toBeNull();
    expect(match![1]!.split(/\s+/u).filter(Boolean)).toEqual([
      "dist",
      "scripts",
      "package.json",
      "pnpm-lock.yaml",
      ".env.example",
    ]);
    // sourcemap 在组包阶段被删除（没有 src 时无法对照）
    expect(commands).toContain("*.map");
  });

  it("keeps a dependabot config for actions and npm", () => {
    const text = readFileSync(join(ROOT, ".github", "dependabot.yml"), "utf8");
    const doc = parse(text) as {
      updates?: Array<{
        "package-ecosystem"?: string;
        ignore?: Array<{ "dependency-name"?: string; "update-types"?: string[] }>;
      }>;
    };
    const ecosystems = (doc.updates ?? []).map((item) => item["package-ecosystem"]);
    expect(ecosystems).toContain("github-actions");
    expect(ecosystems).toContain("npm");

    // @types/node 的类型大版本必须跟着运行时 Node 走（当前 24），major 更新一律忽略
    const npmEntry = (doc.updates ?? []).find(
      (item) => item["package-ecosystem"] === "npm",
    );
    const ignored = npmEntry?.ignore?.find(
      (rule) => rule["dependency-name"] === "@types/node",
    );
    expect(ignored?.["update-types"]).toContain("version-update:semver-major");
  });
});
