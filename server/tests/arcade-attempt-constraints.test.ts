// server/tests/arcade-attempt-constraints.test.ts
//
// `pending_authorizations` declares two unions in TypeScript — `holder` and `outcome` — and
// drizzle's `$type<>` is erased at runtime, so only the database can hold them. These are the
// checks the sibling table `brokered_connections` has had all along, asked of the new table:
// a holder outside the pair, an outcome outside the roster, and the two holder/`user_id`
// combinations `brokered_connections_holder_check` exists to make impossible.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { mcpServers, pendingAuthorizations } from "../src/db/schema/plugins";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const serverId = `arcade-constraints-${suite}`;

/** An attempt row with every column legal, so each test varies exactly the one it is about. */
const attempt = (overrides: Record<string, unknown>) => ({
  actorId: `actor-${randomUUID().slice(0, 8)}`,
  serverId,
  action: "connect",
  holder: "person" as const,
  userId: `user-${suite}`,
  vendorUserId: `v-${suite}`,
  ...overrides,
});

// Awaited rather than handed back as a builder, so a failure says what the database did with the
// row and not what drizzle's query object looks like.
const insert = async (overrides: Record<string, unknown>) => {
  await database
    .insert(pendingAuthorizations)
    // biome-ignore lint/suspicious/noExplicitAny: the point is what the DATABASE refuses, past the declared unions.
    .values(attempt(overrides) as any);
};

/**
 * The name of the constraint that refused a statement, or `"accepted"` if nothing did.
 *
 * Named rather than merely thrown, because "it threw" would also pass on a typo in a column name.
 * drizzle's own message is only "Failed query: ..."; the constraint it tripped is `constraint` on
 * the postgres error underneath.
 */
const refusedBy = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? String(error);
  }
  return "accepted";
};

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Attempt constraints",
    vendor: "test",
    url: "https://example.invalid/mcp",
  });
});

afterAll(async () => {
  await database.execute(sql`delete from mcp_servers where id = ${serverId}`);
  await database.$client.close();
});

describe("pending_authorizations holds its declared unions", () => {
  test("a holder outside the pair is refused", async () => {
    expect(await refusedBy(() => insert({ holder: "llama" }))).toBe(
      "pending_authorizations_holder_check",
    );
  });

  test("an outcome outside the roster is refused on insert", async () => {
    expect(await refusedBy(() => insert({ outcome: "banana" }))).toBe(
      "pending_authorizations_outcome_check",
    );
  });

  test("an outcome outside the roster is refused on update", async () => {
    const actorId = `update-${suite}`;
    await insert({ actorId });
    const refusal = await refusedBy(() =>
      database
        .update(pendingAuthorizations)
        // biome-ignore lint/suspicious/noExplicitAny: a cast past the union is exactly what the CHECK is for.
        .set({ outcome: "cancelled" as any })
        .where(sql`actor_id = ${actorId}`),
    );
    expect(refusal).toBe("pending_authorizations_outcome_check");
  });

  test("a person attempt with no user id is refused", async () => {
    expect(
      await refusedBy(() => insert({ holder: "person", userId: null })),
    ).toBe("pending_authorizations_holder_check");
  });

  test("a deployment attempt carrying a user id is refused", async () => {
    expect(
      await refusedBy(() =>
        insert({ holder: "deployment", userId: `user-${suite}` }),
      ),
    ).toBe("pending_authorizations_holder_check");
  });

  test("the legal shapes are all still accepted", async () => {
    const action = `legal-${suite}`;
    await insert({ action, holder: "person", userId: `user-${suite}` });
    await insert({ action, holder: "deployment", userId: null });
    for (const outcome of [
      null,
      "completed",
      "failed",
      "unreconciled",
      "withdrawn",
    ]) {
      await insert({ action, outcome });
    }
    const rows = await database.execute(
      sql`select count(*)::int as n from pending_authorizations where action = ${action}`,
    );
    expect(rows[0]?.n).toBe(7);
  });
});
