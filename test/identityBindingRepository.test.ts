import { describe, expect, it } from "vitest";

import { PostgresIdentityBindingRepository } from "../src/db/identityBindingRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("PostgresIdentityBindingRepository", () => {
  it("deletes stale bindings before inserting the new mapping", async () => {
    const db = new FakeQueryable();
    const repository = new PostgresIdentityBindingRepository(db);

    await repository.bind("user", "openid-user", "123456");

    expect(db.calls).toHaveLength(2);
    expect(db.calls[0]?.text).toContain("DELETE FROM identity_bindings");
    expect(db.calls[0]?.values).toEqual(["user", "openid-user", "123456"]);
    expect(db.calls[1]?.text).toContain("INSERT INTO identity_bindings");
    expect(db.calls[1]?.text).toContain("ON CONFLICT (kind, official_id)");
    expect(db.calls[1]?.values).toEqual(["user", "openid-user", "123456"]);
  });

  it("maps all persisted bindings", async () => {
    const db = new FakeQueryable([
      [
        { kind: "user", official_id: "u1", external_id: "10001" },
        { kind: "group", official_id: "g1", external_id: "654321" },
      ],
    ]);
    const repository = new PostgresIdentityBindingRepository(db);

    await expect(repository.findAll()).resolves.toEqual([
      { kind: "user", officialId: "u1", externalId: "10001" },
      { kind: "group", officialId: "g1", externalId: "654321" },
    ]);
    expect(db.calls[0]?.text).toContain("SELECT kind, official_id, external_id");
  });

  it("rejects unknown binding kinds", async () => {
    const db = new FakeQueryable([
      [{ kind: "channel", official_id: "x", external_id: "y" }],
    ]);
    const repository = new PostgresIdentityBindingRepository(db);

    await expect(repository.findAll()).rejects.toThrow(
      /unknown identity binding kind/u,
    );
  });
});
