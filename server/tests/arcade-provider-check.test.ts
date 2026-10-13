// server/tests/arcade-provider-check.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { brokeredConnections } from "../src/db/schema/plugins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const app = `arcade-check-${randomUUID().slice(0, 8)}`;

/** The constraint a failed insert names, read from the driver's cause rather than drizzle's wrapper. */
const outcome = (run: () => PromiseLike<unknown>) =>
  Promise.resolve()
    .then(run)
    .then(
      () => "inserted",
      (error: Error) =>
        String((error.cause as Error | undefined)?.message ?? error.message),
    );

afterAll(async () => {
  await database.execute(
    sql`delete from brokered_connections where app = ${app}`,
  );
  await database.$client.close();
});

describe("brokered_connections.provider", () => {
  test("an arcade row inserts", async () => {
    expect(
      await outcome(() =>
        database.insert(brokeredConnections).values({
          provider: "arcade",
          app,
          holder: "deployment",
          vendorUserId: `openbot-deployment:arcade:${app}`,
        }),
      ),
    ).toBe("inserted");
  });

  test("an unknown provider is refused by the CHECK", async () => {
    expect(
      await outcome(() =>
        database.insert(brokeredConnections).values({
          provider: "nope" as "arcade",
          app,
          holder: "deployment",
          vendorUserId: "v",
        }),
      ),
    ).toMatch(/brokered_connections_provider_check/);
  });

  /**
   * A row with no provider cannot exist, which is what makes the startup activation count sound.
   *
   * The count behind `assertActivatable` (server/src/index.ts) asks for the rows that are
   * `ne(provider, <the wired provider>)`. A SQL inequality never matches NULL, so a nullable
   * `provider` would make exactly the ambiguous rows invisible to the guard that exists to see
   * them. It is not nullable, and this is the test that keeps it so: drop the NOT NULL and this
   * fails, which is the warning that the guard's predicate has to grow an `IS NULL` arm.
   */
  test("a row with no provider is refused by NOT NULL, so no row hides from the count", async () => {
    expect(
      await outcome(() =>
        database.insert(brokeredConnections).values({
          provider: null as unknown as "arcade",
          app,
          holder: "deployment",
          vendorUserId: "v",
        }),
      ),
    ).toMatch(/null value in column "provider"/);
  });
});
