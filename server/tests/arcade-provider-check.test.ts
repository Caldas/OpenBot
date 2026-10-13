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
});
