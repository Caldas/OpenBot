// server/tests/arcade-attempt-store.integration.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { mcpServers, pendingAuthorizations } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const serverId = `arcade-attempt-store-${suite}`;

const broker: ConnectedAppBroker = {
  // Arcade holds the grant at the vendor, not locally; see `ConnectedAppBroker.grantIsLocal`.
  grantIsLocal: false,
  // Arcade runs the correlated, pollable flow, so this stub DECLARES the sub-surface rather
  // than a null; nothing here reaches either member. See `ConnectedAppBroker.authorizations`.
  authorizations: {
    status: async () => {
      throw new Error("nothing here polls an authorization");
    },
    confirmReturn: async () => {
      throw new Error("nothing here confirms a return leg");
    },
  },
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: "ar_stub",
  }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const policy = { mode: "enforce" as const, deny: [], allow: ["true"] };

const store = createPluginStore({
  brokerProvider: "arcade",
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => policy,
  broker,
  deploymentId: `acme-${suite}`,
  sharedUse: async () => ({ allowed: true }),
});

const account = (actor: string): AccountRef => ({
  holder: "person",
  userId: actor,
  vendorUserId: `v-${actor}`,
});

const claim = (actorId: string, action = "connect") =>
  store.claimAuthorizationAttempt({
    actorId,
    serverId,
    action,
    account: account(actorId),
  });

const age = (actorId: string, interval: string) =>
  database.execute(
    sql`update pending_authorizations set created_at = created_at - ${interval}::interval where actor_id = ${actorId}`,
  );

const actors: string[] = [];
const actor = (name: string) => {
  const id = `${name}-${suite}`;
  actors.push(id);
  return id;
};

beforeAll(async () => {
  await database.insert(mcpServers).values({
    id: serverId,
    title: "Attempt store",
    vendor: "Arcade",
    url: "https://example.invalid/mcp",
  });
});

afterAll(async () => {
  // Cascades to the attempts.
  await database.delete(mcpServers).where(eq(mcpServers.id, serverId));
});

describe("claimAuthorizationAttempt", () => {
  test("succeeds when no attempt exists", async () => {
    const a = actor("fresh");
    const got = await claim(a);
    expect(got.claimed).toBe(true);
    if (!got.claimed) return;
    expect(got.attempt.actorId).toBe(a);
    expect(got.attempt.serverId).toBe(serverId);
    expect(got.attempt.holder).toBe("person");
    expect(got.attempt.userId).toBe(a);
    expect(got.attempt.vendorUserId).toBe(`v-${a}`);
    expect(got.attempt.authId).toBeNull();
  });

  test("a second claim while the first is live returns zero rows and answers the live row", async () => {
    const a = actor("live");
    const first = await claim(a, "connect");
    const second = await claim(a, "reconnect");
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    if (first.claimed && !second.claimed) {
      expect(second.live?.actorId).toBe(a);
      expect(second.live?.action).toBe("connect");
      expect(second.live?.createdAt.getTime()).toBe(
        first.attempt.createdAt.getTime(),
      );
    }
  });

  test("succeeds after the first expired, replacing it", async () => {
    const a = actor("expired");
    await claim(a, "old");
    await age(a, "16 minutes");
    const got = await claim(a, "new");
    expect(got.claimed).toBe(true);
    const rows = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, a));
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe("new");
  });

  test("succeeds after the first completed, replacing it", async () => {
    const a = actor("completed");
    await claim(a, "old");
    await database.execute(
      sql`update pending_authorizations set completed_at = now(), outcome = 'completed' where actor_id = ${a}`,
    );
    const got = await claim(a, "new");
    expect(got.claimed).toBe(true);
    const rows = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, a));
    expect(rows[0]?.action).toBe("new");
    expect(rows[0]?.completedAt).toBeNull();
    expect(rows[0]?.outcome).toBeNull();
  });

  test("two concurrent claims by one actor: exactly one wins", async () => {
    const a = actor("race");
    const results = await Promise.all([claim(a, "one"), claim(a, "two")]);
    expect(results.filter((r) => r.claimed).length).toBe(1);
    expect(results.filter((r) => !r.claimed).length).toBe(1);
  });
});

describe("recordAuthorizationMint", () => {
  test("writes the ar_ onto the attempt and leaves another actor's alone", async () => {
    const a = actor("mint");
    const other = actor("mint-other");
    const mine = await claim(a);
    await claim(other);
    if (!mine.claimed) throw new Error("claim failed");
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt: mine.attempt.createdAt,
      authId: "ar_abc",
    });
    expect(wrote).toBe(true);
    const got = await store.authorizationAttemptFor(a);
    expect(got?.authId).toBe("ar_abc");
    expect((await store.authorizationAttemptFor(other))?.authId).toBeNull();
  });

  test("a mint against a different created_at writes nothing", async () => {
    const a = actor("mint-stale");
    await claim(a);
    const wrote = await store.recordAuthorizationMint({
      actorId: a,
      createdAt: new Date(0),
      authId: "ar_stale",
    });
    expect(wrote).toBe(false);
    expect((await store.authorizationAttemptFor(a))?.authId).toBeNull();
  });
});

describe("discardAuthorizationAttempt", () => {
  test("deletes the named attempt, an unminted one included", async () => {
    const a = actor("discard");
    const got = await claim(a);
    if (!got.claimed) throw new Error("claim failed");
    const deleted = await store.discardAuthorizationAttempt({
      actorId: a,
      createdAt: got.attempt.createdAt,
    });
    expect(deleted).toBe(true);
    expect(await store.authorizationAttemptFor(a)).toBeNull();
  });

  test("leaves a NEWER attempt by the same actor standing", async () => {
    const a = actor("newer");
    const older = await claim(a, "older");
    if (!older.claimed) throw new Error("claim failed");
    await age(a, "16 minutes");
    const newer = await claim(a, "newer");
    expect(newer.claimed).toBe(true);
    if (!newer.claimed) return;
    expect(newer.attempt.createdAt.getTime()).toBeGreaterThan(
      older.attempt.createdAt.getTime(),
    );

    // Aimed at the OLD attempt's created_at: it must not reach the new one.
    const deleted = await store.discardAuthorizationAttempt({
      actorId: a,
      createdAt: older.attempt.createdAt,
    });
    expect(deleted).toBe(false);
    const standing = await store.authorizationAttemptFor(a);
    expect(standing?.action).toBe("newer");
    expect(standing?.createdAt.getTime()).toBe(
      newer.attempt.createdAt.getTime(),
    );
  });
});

describe("authorizationAttemptFor", () => {
  test("answers the live attempt", async () => {
    const a = actor("for-live");
    await claim(a);
    expect((await store.authorizationAttemptFor(a))?.actorId).toBe(a);
  });

  test("answers null when there is none", async () => {
    expect(await store.authorizationAttemptFor(actor("for-none"))).toBeNull();
  });

  test("answers null past the TTL", async () => {
    const a = actor("for-expired");
    await claim(a);
    await age(a, "16 minutes");
    expect(await store.authorizationAttemptFor(a)).toBeNull();
  });
});
