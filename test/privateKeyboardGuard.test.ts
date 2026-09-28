import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 回归守卫：**私信（1:1）卡片的按钮不允许带 `permission.specifyUserIds`**。
 *
 * 真机结论（踩过两次）：客户端会把「指定用户」误判成「无权限操作」——
 * **全局超管点自己收到的处罚通知 / 申诉通知卡也一样**（群里那张卡带它是正常的）。
 * 私信卡片的权限一律只在服务端校验，所以这里用白名单把这条不变量钉死：
 * 新增私信卡片时如果手滑写了 `specifyUserIds`，这个测试会直接红。
 *
 * 允许出现的位置：
 * - `adapters/qqOfficial*`：把 `permission` 编码进官方 payload / 类型定义的适配层（与场景无关）；
 * - `services/messageGuard.ts`：**群内**关键词命中卡上的「我要申诉」（只允许当事人点，群里生效）。
 */
const ALLOWED_FILES = new Set([
  "src/adapters/qqOfficialPayload.ts",
  "src/adapters/qqOfficialTypes.ts",
  "src/services/messageGuard.ts",
]);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "data", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (SKIP_DIRS.has(entry)) {
        continue;
      }
      yield* walk(path);
      continue;
    }
    if (path.endsWith(".ts")) {
      yield path;
    }
  }
}

/** 去掉注释：注释里提到这个字段名（例如「私信卡片不写它」）属于说明，不算违规。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n]*/gu, " ");
}

describe("私信卡片按钮不变量", () => {
  it("只有群内卡片（messageGuard）与适配层允许出现 specifyUserIds", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const relativePath = relative(ROOT, file).split("\\").join("/");
      if (ALLOWED_FILES.has(relativePath)) {
        continue;
      }
      if (stripComments(readFileSync(file, "utf8")).includes("specifyUserIds")) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });
});
