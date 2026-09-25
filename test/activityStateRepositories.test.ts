import { describe, expect, it } from "vitest";

import type { ActivitySettingsRepository } from "../src/db/activitySettingsRepository.js";
import { SqlActivitySettingsRepository } from "../src/db/activitySettingsRepository.js";
import type { ActivityWaitlistRepository } from "../src/db/activityWaitlistRepository.js";
import { SqlActivityWaitlistRepository } from "../src/db/activityWaitlistRepository.js";
import { TEST_DATABASES } from "./helpers/testDatabases.js";

for (const { name, create } of TEST_DATABASES) {
  it(`round-trips the activity waitlist and settings on ${name}`, async () => {
    const database = await create();
    try {
      const waitlist: ActivityWaitlistRepository = new SqlActivityWaitlistRepository(
        database.queryable,
      );
      const settings: ActivitySettingsRepository = new SqlActivitySettingsRepository(
        database.queryable,
      );

      await waitlist.save({
        activityId: "a1",
        userId: "u2",
        displayName: "小红",
        note: "候补一下",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      });
      await waitlist.save({
        activityId: "a1",
        userId: "u1",
        displayName: "小明",
        note: "",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      // 同一 (activity, user) 覆盖，不产生第二行
      await waitlist.save({
        activityId: "a1",
        userId: "u2",
        displayName: "小红（改名）",
        note: "候补一下",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      });

      const rows = await waitlist.findAll();
      expect(rows.map((row) => row.userId)).toEqual(["u1", "u2"]);
      expect(rows[1]?.displayName).toBe("小红（改名）");

      await waitlist.remove("a1", "u1");
      await expect(waitlist.findAll()).resolves.toHaveLength(1);

      await settings.save({ activityId: "a1", key: "mentionAll", value: "true" });
      await settings.save({ activityId: "a1", key: "mentionAll", value: "false" });
      await settings.save({
        activityId: "a1",
        key: "closeAt",
        value: "2026-12-31T23:59:00.000Z",
      });
      const stored = await settings.findAll();
      expect(stored).toHaveLength(2);
      expect(stored.find((row) => row.key === "mentionAll")?.value).toBe("false");

      await settings.remove("a1", "closeAt");
      const after = await settings.findAll();
      expect(after.map((row) => row.key)).toEqual(["mentionAll"]);
    } finally {
      await database.cleanup();
    }
  });
}
