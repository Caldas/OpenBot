// server/tests/arcade-verify.test.ts
/**
 * The verifier's REFUSAL half: a browser coming back from a brokered per-action consent that this
 * deployment will not complete.
 *
 * ALMOST EVERY ASSERTION HERE IS "NOTHING WAS WRITTEN", which is the shape where a broken
 * implementation looks exactly like a passing one. So no case infers that from a status code:
 * each one QUERIES `brokered_connections` for a row belonging to the actor, and `audit_events` for
 * the `mcp.account_connected` entry the completion transaction files, and requires both to be
 * empty. The actor ids are suite-scoped, so a count of zero is a fact about this run.
 *
 * AND IT DRIVES THROUGH `createApp`, NOT THROUGH `createPluginRoutes`. A route that is built but
 * never mounted answers 404 in production while its own factory test passes — the failure every
 * Shared-app surface had before `shared-wiring.integration.test.ts` was written.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getCookies } from "better-auth/cookies";
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { createAuth } from "../src/auth/index";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  auditEvents,
  brokeredConnections,
  mcpServers,
  pendingAuthorizations,
} from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const APP = `arcade-verify-${suite}`;
const ACTOR = `verifier-${suite}`;
const STRANGER = `stranger-${suite}`;
const ACTION = "Gmail.ListEmails";
const MINTED = "ar_minted_for_this_attempt";
const APP_URL = "https://app.example";

/** Every call this suite lets reach the seam. A refusal that spends one is a refusal too late. */
let confirmCalls: { handle: string; vendorUserId: string }[] = [];
/** What the next `confirmReturn` answers, or throws. Set per test. */
let confirmAnswer: () => Promise<
  { authorizationId: string } | { mismatch: true }
> = async () => ({ authorizationId: MINTED });

/**
 * A broker that DECLARES the correlated authorization flow, which is the only thing this route's
 * gate reads. Every member is declared because the seam requires a broker to SAY what it runs; see
 * `ConnectedAppBroker.authorizations` and `.grantIsLocal`.
 */
const broker: ConnectedAppBroker = {
  grantIsLocal: false,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  authorizations: {
    status: async () => {
      throw new Error("the refusal half polls no authorization");
    },
    confirmReturn: async (query) => {
      confirmCalls.push(query);
      return confirmAnswer();
    },
  },
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent?secret=bearer-capability",
    authorizationId: MINTED,
  }),
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => null,
};

/**
 * The deployment as `createApp` builds it, with a session for `who` or none at all.
 *
 * Positional, by index rather than by a run of `undefined`s, for the reason
 * `shared-wiring.integration.test.ts` gives: a parameter added in the middle then moves a type error
 * onto the wrong index here rather than shifting an argument silently.
 */
function build(
  who: string | null,
  options: {
    roles?: string[];
    brokerBag?: { broker: ConnectedAppBroker; provider: string } | undefined;
  } = {},
) {
  const auditStore = createAuditStore(database);
  const pluginStore = createPluginStore({
    brokerProvider: "arcade",
    database,
    auditStore,
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const args = new Array(createApp.length) as unknown as Parameters<
    typeof createApp
  >;
  args[0] = loadConfig(testEnvironment({ OPENBOT_APP_URL: APP_URL }));
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () =>
        who === null
          ? null
          : { user: { id: who, email: `${who}@example.test`, name: "Person" } },
    },
  } as never;
  args[2] = { rolesForUser: async () => options.roles ?? ["user"] } as never;
  args[12] = auditStore;
  args[14] = pluginStore;
  args[29] =
    "brokerBag" in options ? options.brokerBag : { broker, provider: "arcade" };
  return createApp(...args);
}

function verify(
  who: string | null,
  query: string,
  options?: Parameters<typeof build>[1],
) {
  return build(who, options).request(
    `http://openbot.test/api/plugins/arcade/verify${query}`,
  );
}

/** What the completion transaction would have left behind. Queried, never inferred from a status. */
async function written(actorId: string) {
  const connections = await database
    .select()
    .from(brokeredConnections)
    .where(eq(brokeredConnections.userId, actorId));
  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.actorUserId, actorId),
        eq(auditEvents.eventType, "mcp.account_connected"),
      ),
    );
  return { connections: connections.length, successEvents: events.length };
}

async function expectNothingWritten() {
  expect(await written(ACTOR)).toEqual({
    connections: 0,
    successEvents: 0,
  });
  expect(await written(STRANGER)).toEqual({
    connections: 0,
    successEvents: 0,
  });
}

/**
 * One live attempt for `ACTOR`, written directly so its age and its `auth_id` are the test's to
 * choose. `createdAt` is a JS `Date`, which carries only milliseconds — the same precision
 * `claimAuthorizationAttempt` truncates the column to — so a value read back out compares exactly.
 */
async function giveAttempt(options: {
  authId: string | null;
  ageMinutes: number;
}) {
  const createdAt = new Date(
    Math.floor(Date.now() / 1000) * 1000 - options.ageMinutes * 60_000,
  );
  await database.insert(pendingAuthorizations).values({
    actorId: ACTOR,
    serverId: APP,
    action: ACTION,
    holder: "person",
    userId: ACTOR,
    vendorUserId: ACTOR,
    authId: options.authId,
    createdAt,
  });
  return createdAt;
}

beforeEach(async () => {
  confirmCalls = [];
  confirmAnswer = async () => ({ authorizationId: MINTED });
  await database
    .delete(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, ACTOR));
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await database.insert(mcpServers).values({
    id: APP,
    title: "Gmail",
    vendor: "Arcade",
    url: `arcade://Gmail-${suite}`,
    provenance: "arcade",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
});

afterAll(async () => {
  await database
    .delete(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, ACTOR));
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
});

describe("a return leg this deployment will not complete", () => {
  test("an empty flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(ACTOR, "?flow_id=");
    expect(response.status).toBe(400);
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("a missing flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(ACTOR, "");
    expect(response.status).toBe(400);
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("a whitespace-only flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(ACTOR, "?flow_id=%20%20%09");
    expect(response.status).toBe(400);
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("no attempt at all is refused", async () => {
    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.status).toBe(400);
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("an attempt past the fifteen-minute TTL is refused", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 20 });
    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.status).toBe(400);
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("an attempt whose mint never answered an id is refused", async () => {
    await giveAttempt({ authId: null, ageMinutes: 1 });
    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.status).toBe(400);
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  /**
   * THE LATE CALLBACK. The vendor confirms, honestly, an authorization that is not the one this
   * deployment is holding — the read attempt that expired arriving behind the send attempt that
   * replaced it. The replacement must be left EXACTLY as it was, so the row itself is read back
   * rather than the status code being trusted to imply it.
   */
  test("a confirmation naming a different attempt refuses and leaves the row untouched", async () => {
    const createdAt = await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    confirmAnswer = async () => ({ authorizationId: "ar_some_other_attempt" });

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.status).toBe(400);
    expect(confirmCalls).toEqual([{ handle: "flow-abc", vendorUserId: ACTOR }]);

    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, ACTOR));
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    expect(row?.authId).toBe(MINTED);
    expect(row?.createdAt.getTime()).toBe(createdAt.getTime());
    await expectNothingWritten();
  });

  /**
   * The vendor saying the handle is somebody else's. MOCKED-ONLY: the SDK declares no error shape
   * for this, so the adapter's detection is an assumption until a live probe runs. A passing test
   * here is not proof the path works — what it pins is that the route refuses cleanly and writes
   * nothing when the seam DOES answer this way.
   */
  test("a handle the vendor says is somebody else's refuses", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    confirmAnswer = async () => ({ mismatch: true });

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.status).toBe(400);

    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, ACTOR));
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });

  /**
   * Somebody else's browser, or the same person signed in as somebody else. The attempt is keyed on
   * the signed-in person and is never found from the handle, so there is nothing to correlate to.
   */
  test("coming back signed in as a different person refuses", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(STRANGER, "?flow_id=flow-abc");
    expect(response.status).toBe(400);
    expect(confirmCalls).toEqual([]);

    const [row] = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, ACTOR));
    expect(row?.completedAt).toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });
});

describe("a return leg with no session", () => {
  /**
   * NOT 401 JSON. The caller is a person's browser on a top-level navigation with a just-completed
   * consent behind it, and the handle has to survive the trip so signing back in as the same person
   * can resume.
   */
  test("is sent to sign-in with its flow_id, not answered with an error object", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(null, "?flow_id=flow%2Fabc");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${APP_URL}/sign?flow_id=flow%2Fabc`,
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });
});

describe("a return leg with a session whose role was removed", () => {
  test("is told so with a 403, not sent to a sign-in that cannot help", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(ACTOR, "?flow_id=flow-abc", { roles: [] });
    expect(response.status).not.toBe(303);
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });
});

describe("a deployment whose broker runs no correlated authorization flow", () => {
  test("a broker declaring authorizations: null answers 503", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(ACTOR, "?flow_id=flow-abc", {
      brokerBag: {
        broker: { ...broker, authorizations: null },
        provider: "composio",
      },
    });
    expect(response.status).toBe(503);
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("no broker bag at all answers 503", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(ACTOR, "?flow_id=flow-abc", {
      brokerBag: undefined,
    });
    expect(response.status).toBe(503);
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("the gate does not answer before the session is checked", async () => {
    const response = await verify(null, "?flow_id=flow-abc", {
      brokerBag: undefined,
    });
    expect(response.status).toBe(303);
  });
});

/**
 * THE COOKIE POLICY THIS ROUTE DEPENDS ON, AND NOTHING ELSE IN THE SUITE WOULD REPORT IT.
 *
 * `SameSite=Lax` is the one value that lets the session cookie travel on a top-level cross-site GET
 * navigation, which is exactly the leg a person makes coming back from the broker's consent screen.
 * `Strict` withholds it there and nowhere else: the verifier would find no session and send
 * everybody to sign-in, every other route would keep working, and no other test would fail. So the
 * policy is asserted through the deployment's OWN auth configuration — `getCookies` is what Better
 * Auth itself uses to build the attributes, so an override added under `advanced` is read here the
 * same way the browser would read it.
 */
test("the session cookie is SameSite=Lax, which is what lets it survive the return leg", () => {
  const config = loadConfig(testEnvironment({ OPENBOT_APP_URL: APP_URL }));
  const auth = createAuth(config, database);
  expect(getCookies(auth.options).sessionToken.attributes.sameSite).toBe("lax");
});
