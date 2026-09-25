import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 仓库隐私守卫：示例里不允许出现**真实可识别标识**（本人 QQ号、真实群号、真实 openid）。
 *
 * 关键约束：**本文件不保存任何真实值**（连片段都不存），只用"形状规则"判断：
 *
 * - 9-12 位纯数字 → 必须要么是学号形状（11 位、以 2 开头，含用于校验测试的非法样例），
 *   要么在下面的**示例白名单**里；
 * - 32 位十六进制串（openid 形状）与「6-8 位十六进制 + `...`」（截断展示的 openid）→
 *   必须在示例白名单里。
 *
 * 白名单里的每个值都必须是**一眼假**的占位符；往白名单里加值，等于主动声明"这个值可以公开"。
 * 另外支持可选的外部黑名单：设置 `PRIVACY_GUARD_IDS`（逗号分隔）时，额外断言这些具体值
 * 不出现在仓库里 —— 真实值只留在本地环境变量，**永远不要写进代码**。
 */
const ALLOWED_EXAMPLE_NUMBERS = new Set([
  "123456789", // 通用假 QQ号
  "1234567890", // 通用假 QQ号
  "99999999999", // 通用假号码
  "2022123456", // 「长度非法的学号」测试样例
]);

const ALLOWED_EXAMPLE_HEX = new Set([
  "0123456789ABCDEF0123456789ABCDEF", // 明显是顺序拼接的假 openid
  "A1B2C3D4...", // 截断展示用的假 openid 前缀
]);

const STUDENT_ID_SHAPE = /^2\d{10}$/u;
const LONG_DIGITS = /(?<![\dA-Za-z])\d{9,12}(?![\dA-Za-z])/gu;
const HEX_32 = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32}(?![0-9A-Fa-f])/gu;
const HEX_PREFIX_DOTS = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{6,8}\.\.\./gu;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["src", "test", "scripts", "docs"];
const SCAN_FILES = ["README.md", "CHANGELOG.md", ".env.example"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "data", "coverage"]);
const SELF = fileURLToPath(import.meta.url);

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
    yield path;
  }
}

/** 去掉 URL：文档里的外部链接（如法规页面）带长数字，不是标识。 */
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gu, " ");
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    files.push(...walk(join(ROOT, dir)));
  }
  files.push(...SCAN_FILES.map((file) => join(ROOT, file)));
  return files;
}

describe("repository privacy guard", () => {
  it("uses no long numbers or openid-shaped tokens outside the placeholder list", () => {
    const offenders: string[] = [];
    for (const file of collectFiles()) {
      if (file === SELF) {
        continue; // 本文件只放规则与白名单，不放真实值
      }
      const text = stripUrls(readFileSync(file, "utf8"));
      const where = file.replace(ROOT, "");
      for (const match of text.matchAll(LONG_DIGITS)) {
        const value = match[0];
        if (STUDENT_ID_SHAPE.test(value)) {
          continue;
        }
        if (!ALLOWED_EXAMPLE_NUMBERS.has(value)) {
          offenders.push(`${where}: 未登记的 ${value.length} 位数字`);
        }
      }
      for (const pattern of [HEX_32, HEX_PREFIX_DOTS]) {
        for (const match of text.matchAll(pattern)) {
          if (!ALLOWED_EXAMPLE_HEX.has(match[0])) {
            offenders.push(`${where}: 未登记的 openid 形状串`);
          }
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("contains no locally configured real identifiers", () => {
    const configured = (process.env.PRIVACY_GUARD_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (configured.length === 0) {
      // 没配置就跳过：真实值只存在于本地环境变量里，不进仓库
      return;
    }
    const offenders: string[] = [];
    for (const file of collectFiles()) {
      const text = readFileSync(file, "utf8");
      for (const needle of configured) {
        if (text.includes(needle)) {
          offenders.push(file.replace(ROOT, ""));
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});
