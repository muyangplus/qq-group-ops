import { newDb } from "pg-mem";
import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config.js";
import { PostgresIdentityBindingRepository } from "../src/db/identityBindingRepository.js";
import { migrate } from "../src/db/migrate.js";
import { PgQueryable } from "../src/db/pgQueryable.js";
import { createRuntime } from "../src/runtime.js";
import { IdentityMapService } from "../src/services/identityMap.js";

function createQueryable(): PgQueryable {
  const db = newDb();
  const pg = db.adapters.createPg();
  const pool = new pg.Pool() as unknown as ConstructorParameters<
    typeof PgQueryable
  >[0];
  return new PgQueryable(pool);
}

describe("identity bindings against a real SQL engine (pg-mem)", () => {
  it("keeps bindings after a service restart", async () => {
    const queryable = createQueryable();
    await migrate(queryable);
    const repository = new PostgresIdentityBindingRepository(queryable);

    const first = new IdentityMapService(repository);
    await first.bindUser("openid-user", "123456");
    await first.bindGroup("openid-group", "654321");

    const restarted = new IdentityMapService(repository);
    await restarted.reload();

    expect(restarted.getQq("openid-user")).toBe("123456");
    expect(restarted.getGroupNumber("openid-group")).toBe("654321");
    expect(restarted.resolveUserId("123456")).toBe("openid-user");
    expect(restarted.resolveGroupId("654321")).toBe("openid-group");
  });

  it("rebinds a user to a new QQ number", async () => {
    const queryable = createQueryable();
    await migrate(queryable);
    const repository = new PostgresIdentityBindingRepository(queryable);
    const map = new IdentityMapService(repository);

    await map.bindUser("openid-user", "123456");
    await map.bindUser("openid-user", "999999");

    const registry = await repository.findAll();
    expect(registry).toEqual([
      { kind: "user", officialId: "openid-user", externalId: "999999" },
    ]);
  });

  it("moves a QQ number from one user to another", async () => {
    const queryable = createQueryable();
    await migrate(queryable);
    const repository = new PostgresIdentityBindingRepository(queryable);
    const map = new IdentityMapService(repository);

    await map.bindUser("first-user", "123456");
    await map.bindUser("second-user", "123456");

    const registry = await repository.findAll();
    expect(registry).toEqual([
      { kind: "user", officialId: "second-user", externalId: "123456" },
    ]);
  });

  it("clears both sides when a user takes over another user's QQ number", async () => {
    const queryable = createQueryable();
    await migrate(queryable);
    const repository = new PostgresIdentityBindingRepository(queryable);
    const map = new IdentityMapService(repository);

    await map.bindUser("first-user", "111111");
    await map.bindUser("second-user", "222222");
    await map.bindUser("first-user", "222222");

    const registry = await repository.findAll();
    expect(registry).toEqual([
      { kind: "user", officialId: "first-user", externalId: "222222" },
    ]);
    expect(map.getQq("second-user")).toBeUndefined();
  });

  it("keeps user and group namespaces independent", async () => {
    const queryable = createQueryable();
    await migrate(queryable);
    const repository = new PostgresIdentityBindingRepository(queryable);
    const map = new IdentityMapService(repository);

    await map.bindUser("shared-id", "123456");
    await map.bindGroup("shared-id", "123456");

    expect(map.getQq("shared-id")).toBe("123456");
    expect(map.getGroupNumber("shared-id")).toBe("123456");
  });

  it("restores a binding created through the command router after restart", async () => {
    const queryable = createQueryable();
    await migrate(queryable);
    const repository = new PostgresIdentityBindingRepository(queryable);

    const first = createRuntime(loadSettings({}), {
      identityBindings: repository,
    });
    const bind = await first.router.handle({
      type: "private_message",
      userId: "u1",
      messageId: "m1",
      content: "/bind qq 123456",
    });
    expect(bind.ok).toBe(true);
    expect(bind.text).toContain("已保存到数据库");

    const restarted = createRuntime(loadSettings({}), {
      identityBindings: repository,
    });
    await restarted.identityMap.reload();

    expect(restarted.identityMap.getQq("u1")).toBe("123456");
    const query = await restarted.router.handle({
      type: "private_message",
      userId: "u1",
      messageId: "m2",
      content: "/myperm",
    });
    expect(query.ok).toBe(true);
  });
});
