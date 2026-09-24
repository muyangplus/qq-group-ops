import { describe, expect, it } from "vitest";

import { SqlClassAliasRepository } from "../src/db/classAliasRepository.js";
import { FakeQueryable } from "./helpers/fakeQueryable.js";
import { TEST_DATABASES } from "./helpers/testDatabases.js";

describe("SqlClassAliasRepository", () => {
  it("upserts aliases", async () => {
    const db = new FakeQueryable();
    const repository = new SqlClassAliasRepository(db);

    await repository.save({
      alias: "环工2214",
      target: "环境类2214",
      kind: "class",
    });

    expect(db.calls[0]?.text).toContain("INSERT INTO class_aliases");
    expect(db.calls[0]?.values).toEqual([
      "环工2214",
      "环境类2214",
      "class",
    ]);
  });

  it("maps rows back to aliases", async () => {
    const db = new FakeQueryable([
      [
        { alias: "a", target: "b", kind: "class" },
        { alias: "c", target: "d", kind: "college" },
      ],
    ]);
    const repository = new SqlClassAliasRepository(db);

    await expect(repository.findAll()).resolves.toEqual([
      { alias: "a", target: "b", kind: "class" },
      { alias: "c", target: "d", kind: "college" },
    ]);
    expect(db.calls[0]?.text).toContain("FROM class_aliases");
  });

  it("deletes by alias", async () => {
    const db = new FakeQueryable();
    const repository = new SqlClassAliasRepository(db);

    await repository.remove("环工2214");

    expect(db.calls[0]?.text).toContain("DELETE FROM class_aliases");
    expect(db.calls[0]?.values).toEqual(["环工2214"]);
  });

  for (const { name, create } of TEST_DATABASES) {
    it(`round-trips on ${name}`, async () => {
      const database = await create();
      try {
        const repository = new SqlClassAliasRepository(database.queryable);
        await repository.save({
          alias: "环工2214",
          target: "环境类2214",
          kind: "class",
        });
        // 同一别名覆盖：只保留最新目标
        await repository.save({
          alias: "环工2214",
          target: "环境类2215",
          kind: "class",
        });
        await repository.save({
          alias: "化生学院",
          target: "化学与生命科学学院",
          kind: "college",
        });

        const rows = await repository.findAll();
        expect(rows).toEqual([
          { alias: "化生学院", target: "化学与生命科学学院", kind: "college" },
          { alias: "环工2214", target: "环境类2215", kind: "class" },
        ]);

        await repository.remove("环工2214");
        await expect(repository.findAll()).resolves.toEqual([
          { alias: "化生学院", target: "化学与生命科学学院", kind: "college" },
        ]);
      } finally {
        await database.cleanup();
      }
    });
  }
});
