// server/tests/arcade-disconnect-cascade.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents, brokeredConnections } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const gmail = `Gmail-${suite}`;
const calendar = `GoogleCalendar-${suite}`;
const slack = `Slack-${suite}`;
const drive = `GoogleDrive-${suite}`;
const lonely = `Lonely-${suite}`;

const providerOf: Record<string, string | null> = {
  [gmail]: "google",
  [calendar]: "google",
  [drive]: null, // the resolver cannot answer for this one
  [slack]: "slack",
  [lonely]: "google",
};

/** What the vendor was asked to revoke, in order, and whether it should refuse. */
const revoked: string[] = [];
let refuseRevoke = false;

const broker: ConnectedAppBroker = {
  grantIsLocal: false,
  authorizations: {
    status: async () => {
      throw new Error("nothing here polls an authorization");
    },
    confirmReturn: async () => {
      throw new Error("nothing here confirms a return leg");
    },
  },
  authProviderOf: async (toolkit) => providerOf[toolkit] ?? null,
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: "ar_1",
  }),
  isConnected: async () => true,
  revoke: async ({ toolkit }) => {
    revoked.push(toolkit);
    if (refuseRevoke)
      throw new Error("Arcade revoke failed for 1 of 2 connections.");
    return true;
  },
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme",
};

const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
  broker,
});

const seeded: string[] = [];
async function hold(app: string, userId: string) {
  seeded.push(app);
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app,
    holder: "person",
    userId,
    vendorUserId: userId,
  });
}
const rowsFor = async (apps: string[]) =>
  (
    await database
      .select({ app: brokeredConnections.app })
      .from(brokeredConnections)
      .where(inArray(brokeredConnections.app, apps))
      .orderBy(asc(brokeredConnections.app))
  ).map((row) => row.app);
// Filed by owner, because the trail is append-only and an earlier test's rows are still there.
const trailFor = (userId: string) =>
  database
    .select({
      app: auditEvents.targetId,
      payload: sql<Record<string, unknown>>`payload`,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.account_disconnected"),
        sql`payload ->> 'owner' = ${userId}`,
      ),
    )
    .orderBy(asc(auditEvents.targetId));

// The audit trail is append-only, so it is never cleaned: every name here carries this run's suffix.
afterEach(async () => {
  if (seeded.length) {
    await database
      .delete(brokeredConnections)
      .where(inArray(brokeredConnections.app, seeded));
  }
  seeded.length = 0;
  revoked.length = 0;
  refuseRevoke = false;
});

const disconnect = (userId: string, toolkit: string) =>
  store.disconnectBrokered({
    toolkit,
    account: { holder: "person", userId, vendorUserId: userId },
    by: userId,
    reason: "self",
  });

describe("the disconnect cascade", () => {
  test("a disconnect whose siblings are two apps removes and audits BOTH local rows", async () => {
    const userId = `person-${suite}-a`;
    await hold(gmail, userId);
    await hold(calendar, userId);
    await hold(slack, userId); // another provider: untouched

    await disconnect(userId, gmail);

    expect(await rowsFor([gmail, calendar, slack])).toEqual([slack]);
    const trail = await trailFor(userId);
    expect(trail.map((event) => event.app)).toEqual([calendar, gmail].sort());
  });

  test("a partial vendor failure THROWS and every local row survives, with no audit row", async () => {
    const userId = `person-${suite}-b`;
    await hold(gmail, userId);
    await hold(calendar, userId);
    refuseRevoke = true;

    await expect(disconnect(userId, gmail)).rejects.toThrow(/revoke failed/);

    expect(await rowsFor([gmail, calendar])).toEqual([calendar, gmail].sort());
    expect(await trailFor(userId)).toEqual([]);
  });

  test("a disconnect with no siblings removes and audits exactly the one app", async () => {
    const userId = `person-${suite}-c`;
    await hold(lonely, userId);
    await hold(slack, userId);

    await disconnect(userId, lonely);

    expect(await rowsFor([lonely, slack])).toEqual([slack]);
    const trail = await trailFor(userId);
    expect(trail.map((event) => event.app)).toEqual([lonely]);
  });

  test("the audit payload carries the unanswered count, an integer and never names", async () => {
    const userId = `person-${suite}-d`;
    await hold(gmail, userId);
    await hold(calendar, userId);
    await hold(drive, userId); // its auth provider cannot be resolved

    await disconnect(userId, gmail);

    // The unanswered app is NOT touched (left out, never guessed)...
    expect(await rowsFor([gmail, calendar, drive])).toEqual([drive]);
    // ...and every row written says that one app was not known.
    const trail = await trailFor(userId);
    expect(trail).toHaveLength(2);
    for (const event of trail) {
      expect(event.payload.unansweredSiblings).toBe(1);
      expect(JSON.stringify(event.payload)).not.toContain(drive);
    }
  });
});
