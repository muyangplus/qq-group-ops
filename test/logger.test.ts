import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  closeLogging,
  configureLogging,
  getLogger,
} from "../src/core/logger.js";

describe("logger", () => {
  it("writes structured debug logs to file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qq-group-ops-log-"));
    const file = join(directory, "debug.log");
    try {
      configureLogging({ level: "debug", file, console: false });
      const log = getLogger("test-module");
      log.debug("hello", { value: 1 });
      await closeLogging();

      const lines = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe("debug");
      expect(lines[0]?.module).toBe("test-module");
      expect(lines[0]?.message).toBe("hello");
      expect(lines[0]?.context).toEqual({ value: 1 });
    } finally {
      configureLogging({ level: "info", console: false, file: "" });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("filters logs below the configured level", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qq-group-ops-log-"));
    const file = join(directory, "warn.log");
    try {
      configureLogging({ level: "warn", file, console: false });
      const log = getLogger("test-module");
      log.debug("debug message");
      log.info("info message");
      log.warn("warn message");
      await closeLogging();

      const content = readFileSync(file, "utf8");
      expect(content).toContain("warn message");
      expect(content).not.toContain("debug message");
      expect(content).not.toContain("info message");
    } finally {
      configureLogging({ level: "info", console: false, file: "" });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
