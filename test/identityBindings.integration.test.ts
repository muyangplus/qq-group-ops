import { describe, expect, it } from "vitest";

import { SqlIdentityBindingRepository } from "../src/db/identityBindingRepository.js";
import { IdentityMapService } from "../src/services/identityMap.js";
import { createPersistentRuntime } from "./helpers/persistenceRuntime.js";
import { TEST_DATABASES } from "./helpers/testDatabases.js";

for (const driver of TEST_DATABASES) {
  describe(`identity bindings against ${driver.name}`, () => {
    it("keeps bindings after reopening the database", async () => {
      const database = await driver.create();
      try {
        const repository = new SqlIdentityBindingRepository(database.queryable);
        const first = new IdentityMapService(repository);
        await first.bindUser("openid-user", "123456");
        await first.bindGroup("openid-group", "654321");

        const restarted = new IdentityMapService(
          new SqlIdentityBindingRepository(await database.restart()),
        );
        await restarted.reload();

        expect(restarted.getQq("openid-user")).toBe("123456");
        expect(restarted.getGroupNumber("openid-group")).toBe("654321");
        expect(restarted.resolveUserId("123456")).toBe("openid-user");
        expect(restarted.resolveGroupId("654321")).toBe("openid-group");
      } finally {
        await database.cleanup();
      }
    });

    it("rebinds a user to a new QQ number", async () => {
      const database = await driver.create();
      try {
        const repository = new SqlIdentityBindingRepository(database.queryable);
        const map = new IdentityMapService(repository);

        await map.bindUser("openid-user", "123456");
        await map.bindUser("openid-user", "999999");

        await expect(repository.findAll()).resolves.toEqual([
          { kind: "user", officialId: "openid-user", externalId: "999999" },
        ]);
      } finally {
        await database.cleanup();
      }
    });

    it("moves a QQ number from one user to another", async () => {
      const database = await driver.create();
      try {
        const repository = new SqlIdentityBindingRepository(database.queryable);
        const map = new IdentityMapService(repository);

        await map.bindUser("first-user", "123456");
        await map.bindUser("second-user", "123456");

        await expect(repository.findAll()).resolves.toEqual([
          { kind: "user", officialId: "second-user", externalId: "123456" },
        ]);
      } finally {
        await database.cleanup();
      }
    });

    it("clears both sides when a user takes over another user's QQ number", async () => {
      const database = await driver.create();
      try {
        const repository = new SqlIdentityBindingRepository(database.queryable);
        const map = new IdentityMapService(repository);

        await map.bindUser("first-user", "111111");
        await map.bindUser("second-user", "222222");
        await map.bindUser("first-user", "222222");

        await expect(repository.findAll()).resolves.toEqual([
          { kind: "user", officialId: "first-user", externalId: "222222" },
        ]);
        expect(map.getQq("second-user")).toBeUndefined();
      } finally {
        await database.cleanup();
      }
    });

    it("keeps user and group namespaces independent", async () => {
      const database = await driver.create();
      try {
        const repository = new SqlIdentityBindingRepository(database.queryable);
        const map = new IdentityMapService(repository);

        await map.bindUser("shared-id", "123456");
        await map.bindGroup("shared-id", "123456");

        expect(map.getQq("shared-id")).toBe("123456");
        expect(map.getGroupNumber("shared-id")).toBe("123456");
      } finally {
        await database.cleanup();
      }
    });

    it("restores a binding created through the command router after restart", async () => {
      const database = await driver.create();
      try {
        const first = createPersistentRuntime(database.queryable);
        const bind = await first.router.handle({
          type: "private_message",
          userId: "u1",
          messageId: "m1",
          content: "/bind qq 123456",
        });
        expect(bind.ok).toBe(true);
        expect(bind.text).toContain("已保存到数据库");
        await first.flush();

        const restarted = createPersistentRuntime(await database.restart());
        await restarted.load();

        expect(restarted.identityMap.getQq("u1")).toBe("123456");
        const query = await restarted.router.handle({
          type: "private_message",
          userId: "u1",
          messageId: "m2",
          content: "/myperm",
        });
        expect(query.ok).toBe(true);
      } finally {
        await database.cleanup();
      }
    });
  });
}
