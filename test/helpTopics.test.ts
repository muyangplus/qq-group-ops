import { describe, expect, it } from "vitest";

import { HELP_TOPICS, findHelpTopic } from "../src/services/helpTopics.js";

describe("help topic registry", () => {
  it("keeps names and aliases unique", () => {
    const seen = new Set<string>();
    for (const topic of HELP_TOPICS) {
      for (const key of [topic.name, ...topic.aliases]) {
        const normalized = key.toLowerCase();
        expect(seen.has(normalized), `duplicate help key: ${key}`).toBe(false);
        seen.add(normalized);
      }
    }
  });

  it("documents every user facing command", () => {
    const names = HELP_TOPICS.map((topic) => topic.name);
    for (const expected of [
      "help",
      "bind",
      "myperm",
      "rules",
      "perm",
      "pending",
      "sync",
      "approve",
      "reject",
      "audit",
      "status",
      "test",
      "whois",
    ]) {
      expect(names, `missing help topic: ${expected}`).toContain(expected);
    }
  });

  it("has a title, requirement and body for every topic", () => {
    for (const topic of HELP_TOPICS) {
      expect(topic.title.length).toBeGreaterThan(0);
      expect(topic.requirement.length).toBeGreaterThan(0);
      expect(typeof topic.allows).toBe("function");
      expect(topic.body).toBeDefined();
    }
  });

  it("finds topics by name, alias and leading slash", () => {
    expect(findHelpTopic("rules")?.name).toBe("rules");
    expect(findHelpTopic("/rules")?.name).toBe("rules");
    expect(findHelpTopic("规则")?.name).toBe("rules");
    expect(findHelpTopic("RULES")?.name).toBe("rules");
    expect(findHelpTopic("  perm  ")?.name).toBe("perm");
    expect(findHelpTopic("nope")).toBeUndefined();
    expect(findHelpTopic(undefined)).toBeUndefined();
    expect(findHelpTopic("")).toBeUndefined();
  });
});
