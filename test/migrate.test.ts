import { describe, expect, it } from "vitest";

import { migrate } from "../src/db/migrate.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";

describe("migrate", () => {
  it("runs the schema SQL", async () => {
    const db = new FakeQueryable();
    await migrate(db);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.text).toContain("CREATE TABLE IF NOT EXISTS audit_records");
    expect(db.calls[0]?.text).toContain("CREATE TABLE IF NOT EXISTS group_configs");
    expect(db.calls[0]?.text).toContain(
      "CREATE TABLE IF NOT EXISTS identity_bindings",
    );
  });
});
