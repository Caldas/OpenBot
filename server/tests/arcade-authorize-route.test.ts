// server/tests/arcade-authorize-route.test.ts
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { APIConnectionError, APIError } from "@arcadeai/arcadejs";
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
const personalApp = `arcade-p-${suite}`;
const sharedApp = `arcade-s-${suite}`;
const composioApp = `composio-p-${suite}`;
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
) {
  const broker = provider === "arcade" ? arcadeBroker : composioBroker;
  const store = createPluginStore({
    brokerProvider: provider,
    database,
    auditStore: createAuditStore(database),
    credentials: {} as never,
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
    deploymentId: `acme-${suite}`,
  });
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

const authorize = (
  app: Hono,
  serverId: string,
  body: unknown = { action: ACTION },
) =>
  app.request(`/api/plugins/servers/${serverId}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
      id: composioApp,
      title: "Composio Gmail",
      vendor: "Composio",
      url: `composio://c${suite}`,
      provenance: "composio",
      authScheme: "OAUTH2",
    },
  ]);
  await database.insert(mcpTools).values(
    [personalApp, sharedApp, composioApp].map((serverId) => ({
      serverId,
      name: ACTION,
    })),
  );
});

afterAll(async () => {
  await database
    .delete(mcpServers)
    .where(inArray(mcpServers.id, [personalApp, sharedApp, composioApp]));
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

describe("POST /servers/:id/authorize", () => {
  test("mints for the named action and the row records the exact account and the authorization id", async () => {
    const actor = person("mint");
    const response = await authorize(appAs("user", actor), personalApp);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorizationUrl: SECRET_URL });
    expect(mints).toEqual([
      { vendorUserId: actor, action: ACTION, toolkit: `P${suite}` },
    ]);
    const [row] = await attemptsFor(actor);
    expect(row).toMatchObject({
      actorId: actor,
      serverId: personalApp,
      action: ACTION,
      holder: "person",
      userId: actor,
      vendorUserId: actor,
      authId: "ar_minted_1",
      completedAt: null,
      outcome: null,
    });
    // created_at round-trips through a JS Date: the mint matched on it, and the stored value is
    // exactly millisecond-precise.
    const created = row?.createdAt as Date;
    expect(new Date(created.getTime()).getTime()).toBe(created.getTime());
    const [exact] = (await database.execute(
      sql`select (created_at = date_trunc('milliseconds', created_at)) as exact
          from pending_authorizations where actor_id = ${actor}`,
    )) as unknown as { exact: boolean }[];
    expect(exact?.exact).toBe(true);
  });

  test("a null authorization id is recorded as NULL, never collapsed", async () => {
    const actor = person("nullid");
    nextAuthId = null;
    const response = await authorize(appAs("user", actor), personalApp);
    expect(response.status).toBe(200);
    const [row] = await attemptsFor(actor);
    expect(row?.authId).toBeNull();
    expect(row?.completedAt).toBeNull();
  });

  test("an action the app does not publish is a 400 with no attempt and no mint", async () => {
    const actor = person("unpublished");
    const response = await authorize(appAs("user", actor), personalApp, {
      action: "Gmail.DeleteEverything",
    });
    expect(response.status).toBe(400);
    expect(mints).toEqual([]);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  test("a differently-cased action is not accepted", async () => {
    const actor = person("cased");
    const response = await authorize(appAs("user", actor), personalApp, {
      action: ACTION.toLowerCase(),
    });
    expect(response.status).toBe(400);
    expect(mints).toEqual([]);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  test("a non-admin on a Shared app is a 403 with no attempt", async () => {
    const actor = person("shared-user");
    const response = await authorize(appAs("user", actor), sharedApp);
    expect(response.status).toBe(403);
    expect(mints).toEqual([]);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  test("an admin on a Shared app records the deployment's account on the row", async () => {
    const actor = person("shared-admin");
    const response = await authorize(appAs("admin", actor), sharedApp);
    expect(response.status).toBe(200);
    const [row] = await attemptsFor(actor);
    expect(row).toMatchObject({
      holder: "deployment",
      userId: null,
      vendorUserId: SHARED_VENDOR_ID,
      authId: "ar_minted_1",
    });
  });

  test("a second authorization while one is live is a 409 naming the first", async () => {
    const actor = person("live");
    const app = appAs("user", actor);
    expect((await authorize(app, personalApp)).status).toBe(200);
    const [first] = await attemptsFor(actor);
    mints = [];
    const second = await authorize(app, personalApp);
    expect(second.status).toBe(409);
    expect(JSON.stringify(await second.json())).toContain(ACTION);
    expect(mints).toEqual([]);
    const [after] = await attemptsFor(actor);
    expect(after?.createdAt.getTime()).toBe(
      first?.createdAt.getTime() as number,
    );
    expect(after?.authId).toBe("ar_minted_1");
  });

  test("an authorization after the first expired succeeds, replacing it", async () => {
    const actor = person("expired");
    const app = appAs("user", actor);
    expect((await authorize(app, personalApp)).status).toBe(200);
    await database.execute(
      sql`update pending_authorizations set created_at = created_at - interval '16 minutes' where actor_id = ${actor}`,
    );
    const [old] = await attemptsFor(actor);
    nextAuthId = "ar_minted_2";
    expect((await authorize(app, personalApp)).status).toBe(200);
    const rows = await attemptsFor(actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authId).toBe("ar_minted_2");
    expect(rows[0]?.createdAt.getTime()).toBeGreaterThan(
      old?.createdAt.getTime() as number,
    );
  });

  test("the authorization url appears in no audit row", async () => {
    const actor = person("audit");
    expect((await authorize(appAs("user", actor), personalApp)).status).toBe(
      200,
    );
    const leaked = await database.execute(
      sql`select id from audit_events
          where payload::text like ${"%bearer-capability%"}
             or target_id like ${"%bearer-capability%"}`,
    );
    expect(leaked.length).toBe(0);
  });

  test("a deployment whose broker runs no authorization flow answers 503 and writes no attempt", async () => {
    const actor = person("composio");
    const response = await authorize(
      appAs("user", actor, "composio"),
      composioApp,
    );
    expect(response.status).toBe(503);
    expect(mints).toEqual([]);
    expect(await attemptsFor(actor)).toEqual([]);
    expect(JSON.stringify(await response.json())).not.toContain(
      "vendor.example",
    );
  });

  test("the gate answers before whose account it is: a non-admin on a Shared app of such a deployment is a 503, not a 403", async () => {
    const actor = person("composio-shared");
    const response = await authorize(
      appAs("user", actor, "composio"),
      sharedApp,
    );
    expect(response.status).toBe(503);
    expect(await attemptsFor(actor)).toEqual([]);
  });

  describe("a mint that fails", () => {
    const refuse = async () => {
      throw new APIError(
        500,
        { name: "boom", message: "vendor-body-secret" },
        "500",
        new Headers(),
      );
    };

    test("a definite vendor refusal deletes the attempt, and a late cleanup can never delete a newer one", async () => {
      const actor = person("definite");
      beforeMint = refuse;
      const response = await authorize(appAs("user", actor), personalApp);
      expect(response.status).toBe(502);
      expect(JSON.stringify(await response.json())).not.toContain(
        "vendor-body-secret",
      );
      expect(await attemptsFor(actor)).toEqual([]);

      // The actor starts again; the first attempt's cleanup then arrives late.
      beforeMint = null;
      nextAuthId = "ar_newer";
      expect((await authorize(appAs("user", actor), personalApp)).status).toBe(
        200,
      );
      const [newer] = await attemptsFor(actor);
      const store = createPluginStore({
        brokerProvider: "arcade",
        database,
        auditStore: createAuditStore(database),
        credentials: {} as never,
        encryptionKey: "x".repeat(44),
        policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
        broker: arcadeBroker,
        deploymentId: `acme-${suite}`,
      });
      const staleCreatedAt = new Date(
        (newer?.createdAt.getTime() as number) - 5,
      );
      expect(
        await store.discardAuthorizationAttempt({
          actorId: actor,
          createdAt: staleCreatedAt,
        }),
      ).toBe(false);
      const [survivor] = await attemptsFor(actor);
      expect(survivor).toMatchObject({
        authId: "ar_newer",
        completedAt: null,
        outcome: null,
      });
      expect(survivor?.createdAt.getTime()).toBe(newer?.createdAt.getTime());
    });

    test("an authored refusal is definite: nothing reached the vendor, so the attempt is deleted", async () => {
      const actor = person("authored");
      const { BrokerRefusalError } = await import("../src/plugins/broker");
      beforeMint = async () => {
        throw new BrokerRefusalError("Arcade needs an action.");
      };
      const response = await authorize(appAs("user", actor), personalApp);
      expect(response.status).toBe(503);
      expect(await attemptsFor(actor)).toEqual([]);
    });

    test("an uncertain failure (status undefined) leaves the attempt standing with a null auth_id", async () => {
      const actor = person("uncertain");
      beforeMint = async () => {
        throw new APIConnectionError({ message: "socket dropped" });
      };
      const response = await authorize(appAs("user", actor), personalApp);
      expect(response.status).toBe(502);
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain("bearer-capability");
      const rows = await attemptsFor(actor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        authId: null,
        completedAt: null,
        outcome: null,
      });
      const created = rows[0]?.createdAt as Date;
      expect(new Date(created.getTime()).getTime()).toBe(created.getTime());
      // ...and it still holds the actor: a second start is a 409, not a second flow.
      beforeMint = null;
      expect((await authorize(appAs("user", actor), personalApp)).status).toBe(
        409,
      );
    });

    test("a non-SDK throw (the adapter's missing-id Error) is uncertain too: the attempt stands", async () => {
      const actor = person("noid");
      beforeMint = async () => {
        throw new Error("Arcade answered an authorization with no id.");
      };
      const response = await authorize(appAs("user", actor), personalApp);
      expect(response.status).toBe(502);
      const [row] = await attemptsFor(actor);
      expect(row).toMatchObject({
        authId: null,
        completedAt: null,
        outcome: null,
      });
    });
  });

  test("two concurrent starts by one actor yield exactly one 200 and one 409", async () => {
    const actor = person("race");
    // Hold the winner's mint open so the loser's claim runs while it is in flight.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeMint = () => held;
    const app = appAs("user", actor);
    const first = authorize(app, personalApp);
    const second = authorize(app, personalApp);
    const settled = Promise.all([first, second]);
    setTimeout(release, 150);
    const responses = await settled;
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mints).toHaveLength(1);
    const rows = await attemptsFor(actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      authId: "ar_minted_1",
      completedAt: null,
      outcome: null,
    });
  });

  test("a Shared app is authorized under the SESSION SUBJECT, not the deployment's credential account", async () => {
    const actor = person("team-bot");
    expect((await authorize(appAs("admin", actor), sharedApp)).status).toBe(
      200,
    );
    const rows = await attemptsFor(actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: actor,
      holder: "deployment",
      vendorUserId: SHARED_VENDOR_ID,
      completedAt: null,
      outcome: null,
    });
    expect(rows[0]?.actorId).not.toBe(SHARED_VENDOR_ID);
    const stray = await database
      .select()
      .from(pendingAuthorizations)
      .where(eq(pendingAuthorizations.actorId, SHARED_VENDOR_ID));
    expect(stray).toEqual([]);
  });
});
