import { describe, expect, it } from "vitest";

import { SqlMenuDeliveryRepository } from "../src/db/menuDeliveryRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";
import { TEST_DATABASES } from "./helpers/testDatabases.js";

describe("SqlMenuDeliveryRepository", () => {
  it("upserts pushed users", async () => {
    const db = new FakeQueryable();
    const repository = new SqlMenuDeliveryRepository(db);

    await repository.markPushed("u1", "2026-01-01T00:00:00.000Z");

    expect(db.calls[0]?.text).toContain("INSERT INTO menu_deliveries");
    expect(db.calls[0]?.values).toEqual(["u1", "2026-01-01T00:00:00.000Z"]);
  });

  it("lists pushed users", async () => {
    const db = new FakeQueryable([[{ user_id: "u1" }, { user_id: "u2" }]]);
    const repository = new SqlMenuDeliveryRepository(db);

    await expect(repository.findAll()).resolves.toEqual(["u1", "u2"]);
  });

  for (const { name, create } of TEST_DATABASES) {
    it(`round-trips on ${name}`, async () => {
      const database = await create();
      try {
        const repository = new SqlMenuDeliveryRepository(database.queryable);
        await repository.markPushed("u1", "2026-01-01T00:00:00.000Z");
        // 重复推送只更新同一行（user_id 是主键）
        await repository.markPushed("u1", "2026-01-02T00:00:00.000Z");
        await repository.markPushed("u2", "2026-01-02T00:00:00.000Z");

        await expect(repository.findAll()).resolves.toEqual(["u1", "u2"]);
      } finally {
        await database.cleanup();
      }
    });
  }
});
