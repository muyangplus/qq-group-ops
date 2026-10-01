import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * D6：依赖审计这条流水线必须**真的会因为漏洞而失败**。
 *
 * 踩过的坑（写的时候差点留下）：`pnpm check:audit | tee report` 的退出码取的是 `tee`，
 * 于是审计永远「通过」。所以这里盯着 `set -o pipefail` 不许被删掉，
 * 顺带守住「脚本用 high 档」「失败要开 issue」这两条。
 */
describe("security audit workflow", () => {
  const workflow = readFileSync(".github/workflows/security-audit.yml", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: Record<string, string>;
  };

  it("定时跑审计脚本", () => {
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("pnpm check:audit");
  });

  it("保留 pipefail：审计失败必须让这一步失败", () => {
    expect(workflow).toContain("set -o pipefail");
  });

  it("check:audit 只把 high / critical 当失败", () => {
    expect(pkg.scripts["check:audit"]).toBe("pnpm audit --audit-level=high");
  });

  it("发现漏洞时自动开 issue", () => {
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("gh issue create");
    expect(workflow).toContain("gh issue comment");
  });
});
