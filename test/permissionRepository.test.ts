import { describe, expect, it } from "vitest";

import { SqlPermissionRepository } from "../src/db/permissionRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("SqlPermissionRepository", () => {
  it("upserts grants idempotently", async () => {
    const db = new FakeQueryable();
    const repository = new SqlPermissionRepository(db);

    await repository.save({
      scope: "group_admin",
      groupId: "g1",
      userId: "u1",
    });

    expect(db.calls[0]?.text).toContain("INSERT INTO permission_grants");
    expect(db.calls[0]?.text).toContain("ON CONFLICT");
    expect(db.calls[0]?.values).toEqual(["group_admin", "g1", "u1"]);
  });

  it("removes grants", async () => {
    const db = new FakeQueryable();
    const repository = new SqlPermissionRepository(db);

    await repository.remove({
      scope: "super_admin",
      groupId: "",
      userId: "u1",
    });

    expect(db.calls[0]?.text).toContain("DELETE FROM permission_grants");
    expect(db.calls[0]?.values).toEqual(["super_admin", "", "u1"]);
  });

  it("maps persisted grants", async () => {
    const db = new FakeQueryable([
      [
        { scope: "super_admin", group_id: "", user_id: "root" },
        { scope: "moderator", group_id: "g1", user_id: "u2" },
      ],
    ]);
    const repository = new SqlPermissionRepository(db);

    await expect(repository.findAll()).resolves.toEqual([
      { scope: "super_admin", groupId: "", userId: "root" },
      { scope: "moderator", groupId: "g1", userId: "u2" },
    ]);
  });

  it("rejects unknown scopes", async () => {
    const db = new FakeQueryable([
      [{ scope: "owner", group_id: "", user_id: "root" }],
    ]);
    const repository = new SqlPermissionRepository(db);
    await expect(repository.findAll()).rejects.toThrow(
      /unknown permission scope/u,
    );
  });
});
