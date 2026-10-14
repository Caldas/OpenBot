// server/tests/arcade-authorize-cancel.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { mcpServers, mcpTools, pendingAuthorizations } from "../src/db/schema";
import type { BrokerProvider } from "../src/plugins/access";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginRoutes } from "../src/plugins/routes";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const personalApp = `arcade-cp-${suite}`;
const sharedApp = `arcade-cs-${suite}`;
const otherApp = `arcade-co-${suite}`;
const movedApp = `arcade-cm-${suite}`;
const SHARED_VENDOR_ID = `openbot-deployment:acme-${suite}:R`;
const ACTION = "Gmail.SendEmail";
const SECRET_URL = "https://vendor.example/consent?secret=bearer-capability";

let mints: { vendorUserId: string; action?: string; toolkit: string }[] = [];
let nextAuthId: string | null = "ar_minted_1";
// What the next mint does before answering; a test sets it to throw, or to hold the mint open.
let beforeMint: (() => Promise<void>) | null = null;

const arcadeBroker: ConnectedAppBroker = {
  grantIsLocal: false,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
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
  authorize: async ({ account, toolkit, action }) => {
    mints.push({ vendorUserId: account.vendorUserId, action, toolkit });
    await beforeMint?.();
    return { redirectUrl: SECRET_URL, authorizationId: nextAuthId };
  },
  isConnected: async () => true,
  revoke: async () => true,
  connectionFields: async () => [],
  connectWithFields: async () => ({ accountId: "ca_1" }),
  revokeAccount: async () => {},
  accountName: async () => "acme-bot",
};

const composioBroker: ConnectedAppBroker = {
  ...arcadeBroker,
  grantIsLocal: true,
  // Nothing here asks what auth provider a connection is held under.
  authProviderOf: async () => null,
  authorizations: null,
  authorize: async ({ account, toolkit, action }) => {
    mints.push({ vendorUserId: account.vendorUserId, action, toolkit });
    return { redirectUrl: SECRET_URL, authorizationId: null };
  },
};

function appAs(
  role: "admin" | "user",
  id: string,
  provider: BrokerProvider = "arcade",
  wrap: (
    store: ReturnType<typeof createPluginStore>,
  ) => ReturnType<typeof createPluginStore> = (s) => s,
) {
  const broker = provider === "arcade" ? arcadeBroker : composioBroker;
  const baseStore = createPluginStore({
    brokerProvider: provider,
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
  const store = wrap(baseStore);
  const signedIn: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", { id, email: `${id}@example.test`, role } as never);
    await next();
  };
  return new Hono().route(
    "/api/plugins",
    createPluginRoutes(
      store,
      signedIn,
      async () => true,
      {
        publicUrl: "https://openbot.example",
        appUrl: "https://app.example",
        encryptionKey: `${"A".repeat(43)}=`,
        personHasAccess: async () => true,
      },
      { broker, provider },
    ),
  );
}

const actors: string[] = [];
const person = (name: string) => {
  const id = `${name}-${suite}`;
  actors.push(id);
  return id;
};

const authorize = (app: Hono, serverId: string) =>
  app.request(`/api/plugins/servers/${serverId}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: ACTION }),
  });
const cancel = (app: Hono, serverId: string) =>
  app.request(`/api/plugins/servers/${serverId}/authorize`, {
    method: "DELETE",
  });

const attemptsFor = (actorId: string) =>
  database
    .select()
    .from(pendingAuthorizations)
    .where(eq(pendingAuthorizations.actorId, actorId));

beforeAll(async () => {
  await database.insert(mcpServers).values([
    {
      id: personalApp,
      title: "Gmail",
      vendor: "Arcade",
      url: `arcade://P${suite}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "personal",
    },
    {
      id: sharedApp,
      title: "Team Gmail",
      vendor: "Arcade",
      url: `arcade://S${suite}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "shared",
      sharedVendorUserId: SHARED_VENDOR_ID,
    },
    {
      id: otherApp,
      title: "Slack",
      vendor: "Arcade",
      url: `arcade://O${suite}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "personal",
    },
    {
      id: movedApp,
      title: "Notion",
      vendor: "Arcade",
      url: `arcade://M${suite}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
      accountMode: "personal",
    },
  ]);
  await database.insert(mcpTools).values(
    [personalApp, sharedApp, otherApp, movedApp].map((serverId) => ({
      serverId,
      name: ACTION,
    })),
  );
});

afterAll(async () => {
  await database
    .delete(mcpServers)
    .where(
      inArray(mcpServers.id, [personalApp, sharedApp, otherApp, movedApp]),
    );
  if (actors.length) {
    await database
      .delete(pendingAuthorizations)
      .where(inArray(pendingAuthorizations.actorId, actors));
  }
  await database.$client.close();
});

beforeEach(() => {
  mints = [];
  nextAuthId = "ar_minted_1";
  beforeMint = null;
});

describe("DELETE /servers/:id/authorize", () => {
  test("cancelling removes the attempt and a fresh authorization immediately succeeds", async () => {
    const actor = person("cancel");
    const app = appAs("user", actor);
    expect((await authorize(app, personalApp)).status).toBe(200);
    expect(await attemptsFor(actor)).toHaveLength(1);

    const response = await cancel(app, personalApp);
    expect(response.status).toBeLessThan(300);
    expect(await attemptsFor(actor)).toEqual([]);

    nextAuthId = "ar_minted_2";
    const again = await authorize(app, personalApp);
    expect(again.status).toBe(200);
    const [row] = await attemptsFor(actor);
    expect(row).toMatchObject({
      authId: "ar_minted_2",
      completedAt: null,
      outcome: null,
    });
    // created_at round-trips through a JS Date: it is what the cancel matches on.
    const created = row?.createdAt as Date;
    const [exact] = (await database.execute(
      sql`select (created_at = ${created.toISOString()}::timestamptz) as exact
          from pending_authorizations where actor_id = ${actor}`,
    )) as unknown as { exact: boolean }[];
    expect(exact?.exact).toBe(true);
  });

  test("cancelling an attempt whose mint never completed (no auth_id) removes it", async () => {
    const actor = person("noid");
    nextAuthId = null;
    const app = appAs("user", actor);
    expect((await authorize(app, personalApp)).status).toBe(200);
    const [before] = await attemptsFor(actor);
    expect(before?.authId).toBeNull();
    expect((await cancel(app, personalApp)).status).toBeLessThan(300);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  test("cancelling when no attempt exists is not an error", async () => {
    const actor = person("none");
    const response = await cancel(appAs("user", actor), personalApp);
    expect(response.status).toBeLessThan(300);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  test("a cancel naming one app does not cancel this actor's attempt on another", async () => {
    const actor = person("otherapp");
    const app = appAs("user", actor);
    expect((await authorize(app, personalApp)).status).toBe(200);
    const [before] = await attemptsFor(actor);
    expect(before?.serverId).toBe(personalApp);

    const response = await cancel(app, otherApp);
    expect(response.status).toBeLessThan(300);
    expect(await response.json()).toEqual({ cancelled: false });

    const [after] = await attemptsFor(actor);
    expect(after?.serverId).toBe(personalApp);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());
    expect(after?.authId).toBe("ar_minted_1");
  });

  test("a cancel issued for an OLD created_at does not remove a NEWER attempt by the same actor", async () => {
    const actor = person("stale");
    const plain = appAs("user", actor);
    expect((await authorize(plain, personalApp)).status).toBe(200);
    const [old] = await attemptsFor(actor);
    if (!old) throw new Error("no first attempt");
    // The first attempt expires and a newer one replaces it, completing-in-flight with its own state.
    await database.execute(
      sql`update pending_authorizations set created_at = created_at - interval '16 minutes' where actor_id = ${actor}`,
    );
    const stale = {
      ...old,
      createdAt: new Date(old.createdAt.getTime() - 16 * 60 * 1000),
    };
    nextAuthId = "ar_newer";
    expect((await authorize(plain, personalApp)).status).toBe(200);
    const [newer] = await attemptsFor(actor);
    expect(newer?.createdAt.getTime()).toBeGreaterThan(
      stale.createdAt.getTime(),
    );

    // The cancel resolves the attempt it was issued for (the old one) and then loses the race.
    const racing = appAs("user", actor, "arcade", (store) => ({
      ...store,
      authorizationAttemptFor: async () => stale,
    }));
    expect((await cancel(racing, personalApp)).status).toBeLessThan(300);

    const [after] = await attemptsFor(actor);
    expect(after?.createdAt.getTime()).toBe(
      newer?.createdAt.getTime() as number,
    );
    expect(after?.authId).toBe("ar_newer");
    expect(after?.completedAt).toBeNull();
    expect(after?.outcome).toBeNull();
  });

  /*
   * B5. CANCELLING IS AN OPERATION ON THE ATTEMPT, AND THE ATTEMPT OUTLIVES WHAT THE APP LOOKS
   * LIKE. The route used to resolve the app FIRST and refuse on anything `brokeredAccountFor`
   * refuses — while reading nothing off its success branch. So every way an app can stop
   * resolving, with a live attempt still standing, was a person holding a pending authorization
   * they could not retract: the attempt key is the actor ALONE, so that one row also refused them
   * a new authorization on ANY app for the full fifteen minutes.
   *
   * A HARD `DELETE` OF THE SERVER ROW IS NOT ONE OF THOSE WAYS, and that is worth writing down
   * rather than testing: `pending_authorizations.server_id` is `references(mcpServers.id,
   * { onDelete: "cascade" })`, so `removeServer` takes the attempt with it and there is nothing
   * left to cancel. The two below are reachable, and both by an administrator doing something
   * ordinary.
   */
  test("an attempt on an app whose url no longer parses as brokered can still be cancelled", async () => {
    const actor = person("moved");
    const app = appAs("user", actor);
    expect((await authorize(app, movedApp)).status).toBe(200);
    expect(await attemptsFor(actor)).toHaveLength(1);

    // The app is re-pointed at an ordinary MCP endpoint: `appOfUrl` now answers null for it.
    await database
      .update(mcpServers)
      .set({ url: `https://moved-${suite}.example/mcp` })
      .where(eq(mcpServers.id, movedApp));
    try {
      const response = await cancel(app, movedApp);
      expect(response.status).toBeLessThan(300);
      expect(await response.json()).toEqual({ cancelled: true });
      expect(await attemptsFor(actor)).toEqual([]);
    } finally {
      await database
        .update(mcpServers)
        .set({ url: `arcade://M${suite}` })
        .where(eq(mcpServers.id, movedApp));
    }
  });

  test("an administrator demoted mid-consent can still cancel their own Shared-app attempt", async () => {
    const actor = person("demoted");
    expect((await authorize(appAs("admin", actor), sharedApp)).status).toBe(
      200,
    );
    const [before] = await attemptsFor(actor);
    expect(before?.serverId).toBe(sharedApp);
    expect(before?.vendorUserId).toBe(SHARED_VENDOR_ID);

    // The same person, no longer an administrator, with their own consent still in flight.
    const response = await cancel(appAs("user", actor), sharedApp);
    expect(response.status).toBeLessThan(300);
    expect(await response.json()).toEqual({ cancelled: true });
    expect(await attemptsFor(actor)).toEqual([]);
  });

  /*
   * AND THE REFUSALS ARE NOT TRADED AWAY FOR THAT. With nothing of this actor's to cancel, a
   * DELETE aimed at a row that is not brokered is still told so, rather than flattened into a
   * `{ cancelled: false }` that claims the request was understood.
   */
  test("with no attempt of this actor's, a non-brokered app is still refused in so many words", async () => {
    const actor = person("refused");
    const app = appAs("user", actor);
    await database
      .update(mcpServers)
      .set({ url: `https://refused-${suite}.example/mcp` })
      .where(eq(mcpServers.id, movedApp));
    try {
      const response = await cancel(app, movedApp);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "That app is not reached through a broker.",
      });
    } finally {
      await database
        .update(mcpServers)
        .set({ url: `arcade://M${suite}` })
        .where(eq(mcpServers.id, movedApp));
    }
  });
});
