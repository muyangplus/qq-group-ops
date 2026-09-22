import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadEnvFile, parseEnvFile } from "../src/env.js";

describe("parseEnvFile", () => {
  it("parses keys, comments and quoted values", () => {
    const values = parseEnvFile(`
# comment
QQ_BOT_APP_ID=123
QQ_BOT_CLIENT_SECRET="secret"
WARNING_MESSAGE='请遵守群规'
DATABASE_URL=postgres://user:pass@localhost:5432/db?sslmode=disable
`);
    expect(values).toEqual({
      QQ_BOT_APP_ID: "123",
      QQ_BOT_CLIENT_SECRET: "secret",
      WARNING_MESSAGE: "请遵守群规",
      DATABASE_URL: "postgres://user:pass@localhost:5432/db?sslmode=disable",
    });
  });
});

describe("loadEnvFile", () => {
  it("loads values into the target environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "qq-group-ops-"));
    const file = join(directory, ".env");
    try {
      writeFileSync(file, "QQ_BOT_APP_ID=from-file\nQQ_BOT_SANDBOX=true\n", "utf8");
      const env: NodeJS.ProcessEnv = {};
      loadEnvFile(file, env);
      expect(env.QQ_BOT_APP_ID).toBe("from-file");
      expect(env.QQ_BOT_SANDBOX).toBe("true");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not override existing environment values", () => {
    const directory = mkdtempSync(join(tmpdir(), "qq-group-ops-"));
    const file = join(directory, ".env");
    try {
      writeFileSync(file, "QQ_BOT_APP_ID=from-file\n", "utf8");
      const env: NodeJS.ProcessEnv = { QQ_BOT_APP_ID: "existing" };
      loadEnvFile(file, env);
      expect(env.QQ_BOT_APP_ID).toBe("existing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
