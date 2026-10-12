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
const SHARED_VENDOR_ID = `openbot-deployment:acme-${suite}:R`;
const ACTION = "Gmail.SendEmail";
const SECRET_URL = "https://vendor.example/consent?secret=bearer-capability";

let mints: { vendorUserId: string; action?: string; toolkit: string }[] = [];
let nextAuthId: string | null = "ar_minted_1";
// What the next mint does before answering; a test sets it to throw, or to hold the mint open.
let beforeMint: (() => Promise<void>) | null = null;

const arcadeBroker: ConnectedAppBroker = {
  grantIsLocal: false,
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
  ]);
  await database
    .insert(mcpTools)
    .values(
      [personalApp, sharedApp].map((serverId) => ({ serverId, name: ACTION })),
    );
});

afterAll(async () => {
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [personalApp, sharedApp]));
  if (actors.length) {
    await database
      .delete(pendingAuthorizations)
      .where(inArray(pendingAuthorizations.actorId, actors));
  }
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
});
