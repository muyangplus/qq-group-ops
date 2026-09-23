import { describe, expect, it } from "vitest";

import { PostgresGroupMessageModeRepository } from "../src/db/groupMessageModeRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("PostgresGroupMessageModeRepository", () => {
  it("upserts group message modes", async () => {
    const db = new FakeQueryable();
    const repository = new PostgresGroupMessageModeRepository(db);

    await repository.save({ groupId: "g1", mode: "all" });

    expect(db.calls[0]?.text).toContain("INSERT INTO group_message_modes");
    expect(db.calls[0]?.values).toEqual(["g1", "all"]);
  });

  it("maps persisted modes", async () => {
    const db = new FakeQueryable([
      [
        { group_id: "g1", mode: "all" },
        { group_id: "g2", mode: "at_only" },
      ],
    ]);
    const repository = new PostgresGroupMessageModeRepository(db);

    await expect(repository.findAll()).resolves.toEqual([
      { groupId: "g1", mode: "all" },
      { groupId: "g2", mode: "at_only" },
    ]);
  });

  it("rejects unknown modes", async () => {
    const db = new FakeQueryable([[{ group_id: "g1", mode: "sometimes" }]]);
    const repository = new PostgresGroupMessageModeRepository(db);
    await expect(repository.findAll()).rejects.toThrow(
      /unknown group message mode/u,
    );
  });
});
