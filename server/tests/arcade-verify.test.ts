// server/tests/arcade-verify.test.ts
/**
 * The verifier: a browser coming back from a brokered per-action consent, refused or completed.
 *
 * ALMOST EVERY ASSERTION HERE IS "NOTHING WAS WRITTEN", which is the shape where a broken
 * implementation looks exactly like a passing one. So no case infers that from a status code:
 * each one QUERIES `brokered_connections` for a row belonging to this suite's app, and
 * `audit_events` for the `mcp.account_connected` entry the completion transaction files, and
 * requires both to be empty. The app name is suite-scoped, so a count of zero is a fact about this
 * run.
 *
 * NOR DOES ANY CASE INFER A REFUSAL FROM "IT REDIRECTED". Every exit from this route answers a
 * `Location` — the criterion `/oauth/callback` already holds itself to — so a test that checked the
 * 303 alone would pass for every refusal including the wrong one. Each refusal names the reason code
 * its `?authorized=` parameter has to carry, one for one, and the codes are asserted once AS A SET
 * so a new one cannot appear without this file going red.
 *
 * AND IT DRIVES THROUGH `createApp`, NOT THROUGH `createPluginRoutes`. A route that is built but
 * never mounted answers 404 in production while its own factory test passes — the failure every
 * Shared-app surface had before `shared-wiring.integration.test.ts` was written.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getCookies } from "better-auth/cookies";
import { and, eq, like } from "drizzle-orm";
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
import { AUTHORIZATION_REFUSALS } from "../src/plugins/routes";
import type { AccountRef } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/*
 * SIX CONNECTIONS RATHER THAN THE SHARED `TEST_POOL` OF TWO, because the race below drives two
 * completion TRANSACTIONS at once through two whole apps, and the second blocks on the first's row
 * lock while holding its own connection. `support/database.ts` says a file wanting a different pool
 * asks for one itself.
 */
const database = createDatabase(testDatabaseUrl(), { max: 6 });
const suite = randomUUID().slice(0, 8);
const APP = `arcade-verify-${suite}`;
/**
 * ONE APP PER TEST, because `audit_events` is APPEND-ONLY and cannot be cleaned between them. A
 * fixed name would let a completion's event be counted by the next case's "nothing was written",
 * which is the exact assertion this suite is built on. The app is keyed on its toolkit, so a fresh
 * toolkit per test is a fresh everything.
 */
let TOOLKIT = "";
let apps = 0;
const ACTOR = `verifier-${suite}`;
const STRANGER = `stranger-${suite}`;
const SHARED_IDENTITY = `shared-${suite}`;
const ACTION = "Gmail.ListEmails";
const MINTED = "ar_minted_for_this_attempt";
const APP_URL = "https://app.example";
/** A stand-in for the live `gho_…` the vendor's own status reply carries beside the three fields. */
const TOKEN = `gho_live_access_token_${suite}`;

/** Every call this suite lets reach the seam. A refusal that spends one is a refusal too late. */
let confirmCalls: { handle: string; vendorUserId: string }[] = [];
let statusCalls: string[] = [];
let revokeCalls: { account: AccountRef; toolkit: string }[] = [];
/** What the next `confirmReturn` answers, or throws. Set per test. */
let confirmAnswer: () => Promise<
  { authorizationId: string } | { mismatch: true }
> = async () => ({ authorizationId: MINTED });
/**
 * What the next status read answers. DELIBERATELY WIDER THAN THE SEAM in one case below: the
 * vendor's real reply carries a live access token and a full profile, and the point of that case is
 * that nothing this route touches can carry either anywhere.
 */
let statusAnswer: () => Promise<{
  status: string;
  userId: string | null;
  scopes: string[];
}> = async () => ({
  status: "completed",
  userId: ACTOR,
  scopes: ["gmail.read"],
});
let revokeAnswer: () => Promise<boolean> = async () => true;
/**
 * What auth provider the app's connections are held under. NEVER THE TOOLKIT NAME: the two coincide
 * only where an operator named their provider configuration after the app, so a route deriving one
 * from the other would pass here and be wrong where it shipped.
 */
let authProviderAnswer: () => Promise<string | null> = async () => "google";

/**
 * A broker that DECLARES the correlated authorization flow, which is the only thing this route's
 * gate reads. Every member is declared because the seam requires a broker to SAY what it runs; see
 * `ConnectedAppBroker.authorizations` and `.grantIsLocal`.
 */
const broker: ConnectedAppBroker = {
  grantIsLocal: false,
  authProviderOf: async () => authProviderAnswer(),
  authorizations: {
    status: async (id) => {
      statusCalls.push(id);
      return statusAnswer();
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
  revoke: async (request) => {
    revokeCalls.push(request);
    return revokeAnswer();
  },
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
    /** A handle whose behaviour one case alters; everything else runs on the suite's own. */
    database?: typeof database;
  } = {},
) {
  const handle = options.database ?? database;
  const auditStore = createAuditStore(handle);
  const pluginStore = createPluginStore({
    brokerProvider: "arcade",
    database: handle,
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

/** Where a refusal lands: the LIST, with the reason as an opaque code and no sentence. */
const refusedTo = (reason: string) =>
  `${APP_URL}/settings/connected-accounts?authorized=${reason}`;

/** Where a completion lands: the app's own page, built from the attempt row's `server_id`. */
const LANDING = `${APP_URL}/settings/connected-accounts/${APP}`;

/**
 * A refusal, named by its code and not merely by the fact that something redirected.
 *
 * The transport is the same for all of them, so a check that stopped at the 303 would pass for
 * every one including whichever one is wrong. The code is the whole of the discrimination the
 * status codes used to carry — and `?connected=`, which belongs to the Composio callback, is never
 * along for the ride.
 */
async function expectRefusal(response: Response, reason: string) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(refusedTo(reason));
  expect(response.headers.get("location")).not.toContain("connected=");
}

/** What the completion transaction would have left behind. Queried, never inferred from a status. */
async function written() {
  const connections = await database
    .select()
    .from(brokeredConnections)
    .where(eq(brokeredConnections.app, TOOLKIT));
  const events = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetId, TOOLKIT),
        eq(auditEvents.eventType, "mcp.account_connected"),
      ),
    );
  return { connections, events };
}

async function expectNothingWritten() {
  const { connections, events } = await written();
  expect({
    connections: connections.length,
    successEvents: events.length,
  }).toEqual({ connections: 0, successEvents: 0 });
}

/** The attempt row itself, which is what every "nothing was written" case is really about. */
async function attemptRow(actorId = ACTOR) {
  const [row] = await database
    .select()
    .from(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, actorId));
  return row ?? null;
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
  statusCalls = [];
  revokeCalls = [];
  confirmAnswer = async () => ({ authorizationId: MINTED });
  statusAnswer = async () => ({
    status: "completed",
    userId: ACTOR,
    scopes: ["gmail.read"],
  });
  revokeAnswer = async () => true;
  authProviderAnswer = async () => "google";
  apps += 1;
  TOOLKIT = `Gmail-${suite}-${apps}`;
  await database
    .delete(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, ACTOR));
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
  await database.insert(mcpServers).values({
    id: APP,
    title: "Gmail",
    vendor: "Arcade",
    url: `arcade://${TOOLKIT}`,
    provenance: "arcade",
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
});

afterAll(async () => {
  await database
    .delete(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, ACTOR));
  await database
    .delete(brokeredConnections)
    .where(like(brokeredConnections.app, `Gmail-${suite}-%`));
  await database.delete(mcpServers).where(eq(mcpServers.id, APP));
});

/**
 * THE CLOSED SET, ASSERTED ONCE AND AS A SET.
 *
 * Each refusal below names one of these, so the list and the cases hold each other up: a code added
 * to the route without a case here fails this, and a case naming a code the route cannot send fails
 * its own `Location`.
 */
test("the reasons the verifier can refuse with are a closed set", () => {
  expect([...AUTHORIZATION_REFUSALS]).toEqual([
    "no-broker",
    "not-supported",
    "missing-handle",
    "no-attempt",
    "vendor-unavailable",
    "not-your-authorization",
    "not-finished",
    "authorization-failed",
    "context-changed",
    "not-recorded",
  ]);
});

describe("a return leg this deployment will not complete", () => {
  test("an empty flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(await verify(ACTOR, "?flow_id="), "missing-handle");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("a missing flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(await verify(ACTOR, ""), "missing-handle");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("a whitespace-only flow_id is refused without the vendor being asked", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(ACTOR, "?flow_id=%20%20%09"),
      "missing-handle",
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("no attempt at all is refused", async () => {
    await expectRefusal(await verify(ACTOR, "?flow_id=flow-abc"), "no-attempt");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("an attempt past the fifteen-minute TTL is refused", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 20 });
    await expectRefusal(await verify(ACTOR, "?flow_id=flow-abc"), "no-attempt");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("an attempt whose mint never answered an id is refused", async () => {
    await giveAttempt({ authId: null, ageMinutes: 1 });
    await expectRefusal(await verify(ACTOR, "?flow_id=flow-abc"), "no-attempt");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  /**
   * THE LATE CALLBACK. The vendor confirms, honestly, an authorization that is not the one this
   * deployment is holding — the read attempt that expired arriving behind the send attempt that
   * replaced it. The replacement must be left EXACTLY as it was, so the row itself is read back
   * rather than the answer being trusted to imply it.
   */
  test("a confirmation naming a different attempt refuses and leaves the row untouched", async () => {
    const createdAt = await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    confirmAnswer = async () => ({ authorizationId: "ar_some_other_attempt" });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "not-your-authorization",
    );
    expect(confirmCalls).toEqual([{ handle: "flow-abc", vendorUserId: ACTOR }]);
    expect(statusCalls).toEqual([]);

    const row = await attemptRow();
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

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "not-your-authorization",
    );

    const row = await attemptRow();
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
    await expectRefusal(
      await verify(STRANGER, "?flow_id=flow-abc"),
      "no-attempt",
    );
    expect(confirmCalls).toEqual([]);

    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });

  /**
   * THE VENDOR NOT ANSWERING THE CONFIRMATION AT ALL. Nothing of its reply travels with the
   * refusal — not its sentence, not its body, not the error — because a reply on this leg can carry
   * an authorization url, which is a bearer capability.
   */
  test("a vendor that will not answer the confirmation refuses and writes nothing", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    confirmAnswer = async () => {
      throw new Error("vendor down: https://vendor.example/consent?secret=x");
    };

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    await expectRefusal(response, "vendor-unavailable");
    expect(response.headers.get("location")).not.toContain("vendor.example");

    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
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
  /**
   * THE ONE EXIT WITH NO `Location`, AND IT IS STATED RATHER THAN INHERITED. The guard that refused
   * here is the guard `/api/me` answers from, so this session cannot reliably load the landing page
   * either: it would be sent to `/sign` or into an error boundary, which is the dead end this
   * branch exists to avoid.
   */
  test("is told so with a 403, not sent to a sign-in that cannot help", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    const response = await verify(ACTOR, "?flow_id=flow-abc", { roles: [] });
    expect(response.status).not.toBe(303);
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toHaveProperty("error");
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });
});

describe("a deployment whose broker runs no correlated authorization flow", () => {
  test("a broker declaring authorizations: null refuses as not supported", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", {
        brokerBag: {
          broker: { ...broker, authorizations: null },
          provider: "composio",
        },
      }),
      "not-supported",
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("no broker bag at all refuses as no broker", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", { brokerBag: undefined }),
      "no-broker",
    );
    expect(confirmCalls).toEqual([]);
    await expectNothingWritten();
  });

  test("the gate does not answer before the session is checked", async () => {
    const response = await verify(null, "?flow_id=flow-abc", {
      brokerBag: undefined,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${APP_URL}/sign?flow_id=flow-abc`,
    );
  });
});

describe("what the authorization's own status decides", () => {
  /**
   * A TIMEOUT IS NEITHER A SUCCESS NOR A FAILURE, and the proof is that the attempt is still
   * completable afterwards: the second call below finishes the very same row. A refusal that closed
   * it would leave somebody who came back to the link with nothing to finish.
   */
  test("still pending at the bound refuses and LEAVES THE ATTEMPT STANDING", async () => {
    const createdAt = await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => ({
      status: "pending",
      userId: ACTOR,
      scopes: [],
    });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "not-finished",
    );
    // BOUNDED, and the bound is small: never the SDK's unbounded wait.
    expect(statusCalls.length).toBeGreaterThan(1);
    expect(statusCalls.length).toBeLessThanOrEqual(5);
    expect(statusCalls.every((id) => id === MINTED)).toBe(true);

    const standing = await attemptRow();
    expect(standing?.completedAt).toBeNull();
    expect(standing?.outcome).toBeNull();
    expect(standing?.authId).toBe(MINTED);
    expect(standing?.createdAt.getTime()).toBe(createdAt.getTime());
    await expectNothingWritten();

    // AND IT COMPLETES AFTERWARDS, which is the whole claim.
    statusAnswer = async () => ({
      status: "completed",
      userId: ACTOR,
      scopes: ["gmail.read"],
    });
    const finished = await verify(ACTOR, "?flow_id=flow-abc");
    expect(finished.headers.get("location")).toBe(LANDING);
    const after = await attemptRow();
    expect(after?.outcome).toBe("completed");
    expect(after?.completedAt).not.toBeNull();
    const { connections } = await written();
    expect(connections.length).toBe(1);
  }, 30_000);

  test("a failed authorization refuses and the ROW is marked failed", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => ({
      status: "failed",
      userId: ACTOR,
      scopes: [],
    });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "authorization-failed",
    );
    expect(statusCalls).toEqual([MINTED]);

    const row = await attemptRow();
    expect(row?.outcome).toBe("failed");
    expect(row?.completedAt).not.toBeNull();
    expect(row?.authId).toBe(MINTED);
    await expectNothingWritten();
  });

  test("a status naming a different identity refuses and the ROW is marked failed", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => ({
      status: "completed",
      userId: `somebody-else-${suite}`,
      scopes: ["gmail.read"],
    });

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "not-your-authorization",
    );

    const row = await attemptRow();
    expect(row?.outcome).toBe("failed");
    expect(row?.completedAt).not.toBeNull();
    await expectNothingWritten();
  });

  test("a vendor that will not answer the status refuses and leaves the row standing", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () => {
      throw new Error(`vendor down, token ${TOKEN}`);
    };

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    await expectRefusal(response, "vendor-unavailable");
    expect(response.headers.get("location")).not.toContain(TOKEN);

    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
    await expectNothingWritten();
  });
});

/**
 * D28: a consent whose account context moved on is not completed into the present.
 *
 * The app is switched to Shared between the mint and the callback, which mints a fresh deployment
 * identity. The attempt names the person's own identity, which is now retired.
 */
describe("a consent whose account context has moved on", () => {
  /** The connection the CURRENT identity already holds, which this refusal must not touch. */
  async function giveCurrentAccountAConnection() {
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app: TOOLKIT,
      holder: "deployment",
      userId: null,
      vendorUserId: SHARED_IDENTITY,
      verified: true,
    });
  }

  async function switchToShared() {
    await database
      .update(mcpServers)
      .set({ accountMode: "shared", sharedVendorUserId: SHARED_IDENTITY })
      .where(eq(mcpServers.id, APP));
  }

  test("refuses, withdraws the RETIRED identity's grant and leaves the CURRENT account alone", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    await giveCurrentAccountAConnection();

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "context-changed",
    );

    // THE RETIRED IDENTITY, AND ONLY IT. A connection is keyed on the identity, and the retired one
    // is not the current one, so this cannot reach the account that is live now.
    expect(revokeCalls).toEqual([
      {
        account: { holder: "person", userId: ACTOR, vendorUserId: ACTOR },
        toolkit: TOOLKIT,
      },
    ]);

    // AND THE CURRENT ACCOUNT'S ROW IS STILL THERE, untouched and still the deployment's.
    const { connections, events } = await written();
    expect(connections.length).toBe(1);
    expect(connections[0]?.holder).toBe("deployment");
    expect(connections[0]?.vendorUserId).toBe(SHARED_IDENTITY);
    expect(events.length).toBe(0);

    const row = await attemptRow();
    expect(row?.outcome).toBe("failed");
    expect(row?.completedAt).not.toBeNull();
  });

  test("a withdrawal this deployment could not make keeps the attempt as unreconciled", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    await switchToShared();
    revokeAnswer = async () => {
      throw new Error("the vendor refused the revoke");
    };

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc"),
      "context-changed",
    );

    // A grant we know about and could not end is worth a row somebody can act on.
    const row = await attemptRow();
    expect(row?.outcome).toBe("unreconciled");
    expect(row?.completedAt).not.toBeNull();
    await expectNothingWritten();
  });
});

describe("a return leg that completes", () => {
  test("lands on the app's own page, built from the ATTEMPT ROW", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.status).toBe(303);
    /*
     * FROM THE ATTEMPT ROW'S `server_id`, NEVER FROM A `next_uri`: the vendor refuses every value
     * at mint, and what `confirm_user` answers is the vendor's own success page rather than ours.
     * No notice parameter either — the row it comes back to now reads Connected, which is the same
     * news told by the thing it is news about.
     */
    expect(response.headers.get("location")).toBe(LANDING);
    expect(response.headers.get("location")).not.toContain("authorized=");

    const { connections, events } = await written();
    expect(connections.length).toBe(1);
    expect(connections[0]?.userId).toBe(ACTOR);
    expect(connections[0]?.verified).toBe(true);
    expect(events.length).toBe(1);
    // The action the attempt was for and the scopes the vendor granted, which is ALL of the
    // vendor's answer that is written anywhere.
    expect(events[0]?.payload).toMatchObject({
      action: ACTION,
      scope: "gmail.read",
      // THE BROKER'S ANSWER, NOT THE TOOLKIT NAME. The stub answers a provider that is deliberately
      // nothing like `Gmail-…`, so a route deriving one from the other fails here.
      authProvider: "google",
    });

    const row = await attemptRow();
    expect(row?.outcome).toBe("completed");
    expect(row?.completedAt).not.toBeNull();
  });

  /**
   * A VENDOR THAT DOES NOT SAY WHICH AUTH PROVIDER IT IS records that it did not say, and the
   * consent still completes: the grant is already live at the vendor, and an audit label is not
   * worth refusing it over. Guessing the toolkit name here is the thing the seam forbids.
   */
  test("an auth provider the vendor will not name is recorded as unnamed, and still completes", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    authProviderAnswer = async () => null;

    const response = await verify(ACTOR, "?flow_id=flow-abc");
    expect(response.headers.get("location")).toBe(LANDING);

    const { connections, events } = await written();
    expect(connections.length).toBe(1);
    expect(events[0]?.payload).toMatchObject({ authProvider: "" });
  });

  /**
   * TWO CALLBACKS AT ONCE, with `Promise.all` and never a sequential replay: a replay proves only
   * that the row was already consumed, while the race is what the conditional UPDATE exists for.
   * The loser answers exactly as the winner does, so a duplicate is a no-op rather than an error
   * somebody has to explain.
   */
  test("two CONCURRENT callbacks write exactly one connection and one audit event", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const [first, second] = await Promise.all([
      verify(ACTOR, "?flow_id=flow-abc"),
      verify(ACTOR, "?flow_id=flow-abc"),
    ]);

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(first.headers.get("location")).toBe(LANDING);
    expect(second.headers.get("location")).toBe(LANDING);

    const { connections, events } = await written();
    expect({ connections: connections.length, events: events.length }).toEqual({
      connections: 1,
      events: 1,
    });
  });

  /**
   * A FAILURE BETWEEN THE CONNECTION WRITE AND THE AUDIT WRITE PERSISTS NEITHER.
   *
   * Injected at the DATABASE HANDLE rather than at the store's `auditStore` option, because the
   * audit write that has to be atomic with the connection write is the one bound to the
   * transaction — the same reason `arcade-completion-transaction.integration.test.ts` gives. And it
   * is driven through the route, so the route's own promise — no exit without a `Location` — is
   * held to on the path where its own store throws.
   */
  test("a failure between the two writes persists NEITHER, and still answers a Location", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });

    const brokenAuditDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property !== "transaction") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (work: (tx: unknown) => Promise<unknown>) =>
          target.transaction((transaction) =>
            work(
              new Proxy(transaction, {
                get(txTarget, txProperty, txReceiver) {
                  if (txProperty === "insert") {
                    return (table: unknown) => {
                      if (table === auditEvents)
                        throw new Error("injected audit failure");
                      return txTarget.insert(table as never);
                    };
                  }
                  const value = Reflect.get(txTarget, txProperty, txReceiver);
                  return typeof value === "function"
                    ? value.bind(txTarget)
                    : value;
                },
              }),
            ),
          );
      },
    }) as typeof database;

    await expectRefusal(
      await verify(ACTOR, "?flow_id=flow-abc", {
        database: brokenAuditDatabase,
      }),
      "not-recorded",
    );

    // BOTH TABLES, because "it answered" is not evidence that nothing was written.
    await expectNothingWritten();

    // And the attempt is still claimable, because its UPDATE was in the same transaction.
    const row = await attemptRow();
    expect(row?.completedAt).toBeNull();
    expect(row?.outcome).toBeNull();
  });

  /**
   * SPEC D31. The vendor's own status reply carries a LIVE PROVIDER ACCESS TOKEN and the person's
   * full profile beside the three fields the seam narrows it to. A status response LOOKS LIKE
   * METADATA, which is how the throwaway harness that proved this flow came to write the token to a
   * file on its first run. So this case hands the route a reply carrying one and requires that it
   * reaches no log line, no audit payload, no connection row and no `Location`.
   */
  test("nothing the status answered reaches a log line or an audit row", async () => {
    await giveAttempt({ authId: MINTED, ageMinutes: 1 });
    statusAnswer = async () =>
      ({
        status: "completed",
        userId: ACTOR,
        scopes: ["gmail.read"],
        token: TOKEN,
        context: { token: TOKEN },
        user_info: { email: "person@example.test" },
      }) as never;

    const said: string[] = [];
    const before = globalThis.console;
    const hear = (...args: unknown[]) =>
      said.push(args.map((arg) => String(arg)).join(" "));
    globalThis.console = {
      ...before,
      log: hear,
      info: hear,
      warn: hear,
      error: hear,
      debug: hear,
    } as typeof console;
    let response: Response;
    try {
      response = await verify(ACTOR, "?flow_id=flow-abc");
    } finally {
      globalThis.console = before;
    }

    expect(response.status).toBe(303);
    expect(said.join("\n")).not.toContain(TOKEN);
    expect(response.headers.get("location")).not.toContain(TOKEN);

    const { connections, events } = await written();
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(JSON.stringify(events)).not.toContain("person@example.test");
    expect(JSON.stringify(connections)).not.toContain(TOKEN);
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
