// server/tests/arcade-disconnect-route.test.ts
/**
 * `GET /api/plugins/servers/:id/connection/siblings` and `DELETE /api/plugins/servers/:id/connection`,
 * driven through `createApp`: what ending one app's connection ends besides it, and the cascade.
 *
 * THE ROWS AND THE TRAIL ARE ASSERTED, never a response body alone.
 *
 * SCOPING. `audit_events` is append-only and nothing here is cleaned from it, so every case mints
 * its own `run()`: a fresh `suite+counter` suffix on every app, person and vendor identity it
 * touches. Rows and trail are read through `inArray` on THAT case's app names only, and the
 * "untouched" and "nothing audited" assertions therefore name keys no other case writes — an
 * unwanted deletion or audit row for one of them could only have come from this case.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuditStore } from "../src/audit";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { auditEvents, brokeredConnections, mcpServers } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
let counter = 0;

type Provider = "arcade" | "composio";
let revokes: string[] = [];
let revokeAnswer: boolean | Error = true;

const providerOf = (provider: Provider) => (toolkit: string) =>
  provider === "composio"
    ? toolkit
    : toolkit.startsWith("Slack")
      ? "slack"
      : "google";

function brokerFor(provider: Provider): ConnectedAppBroker {
  return {
    grantIsLocal: false,
    authProviderOf: async (toolkit) => providerOf(provider)(toolkit),
    authorizations: null,
    grantsFor: async () => [],
    listApps: async () => [],
    ensureAuthConfig: async () => "standing",
    deleteAuthConfig: async () => {},
    authorize: async () => ({
      redirectUrl: "https://vendor.example/consent",
      authorizationId: null,
    }),
    isConnected: async () => true,
    revoke: async (request) => {
      revokes.push(request.toolkit);
      if (revokeAnswer instanceof Error) throw revokeAnswer;
      return revokeAnswer;
    },
    connectionFields: async () => [],
    connectWithFields: async () => ({ accountId: "ca_1" }),
    revokeAccount: async () => {},
    accountName: async () => null,
  };
}

function build(who: string, provider: Provider) {
  const broker = brokerFor(provider);
  const auditStore = createAuditStore(database);
  const pluginStore = createPluginStore({
    brokerProvider: provider,
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
  args[0] = loadConfig(
    testEnvironment({ OPENBOT_APP_URL: "https://app.example" }),
  );
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id: who, email: `${who}@example.test`, name: "Person" },
      }),
    },
  } as never;
  args[2] = { rolesForUser: async () => ["user"] } as never;
  args[12] = auditStore;
  args[14] = pluginStore;
  args[29] = { broker, provider };
  return createApp(...args);
}

const toolkits: string[] = [];

/** This case's own names. Nothing another case writes can share one. */
function run(provider: Provider = "arcade") {
  counter += 1;
  const tag = `${suite}${counter}`;
  const names = {
    gmail: `Gmail${tag}`,
    calendar: `GoogleCalendar${tag}`,
    docs: `GoogleDocs${tag}`,
    slack: `Slack${tag}`,
    person: `person-${tag}`,
    shared: `openbot-deployment:acme:${tag}`,
  };
  toolkits.push(names.gmail, names.calendar, names.docs, names.slack);
  revokes = [];
  revokeAnswer = true;
  return { ...names, provider, id: (toolkit: string) => `srv-${toolkit}` };
}

async function app(n: ReturnType<typeof run>, toolkit: string) {
  await database.insert(mcpServers).values({
    id: n.id(toolkit),
    title: toolkit,
    vendor: n.provider === "arcade" ? "Arcade" : "Composio",
    url: `${n.provider}://${toolkit}`,
    provenance: n.provider,
    authScheme: "OAUTH2",
    accountMode: "personal",
  });
}
async function hold(
  n: ReturnType<typeof run>,
  toolkit: string,
  vendorUserId: string,
  holder: "person" | "deployment" = "person",
) {
  await database.insert(brokeredConnections).values({
    provider: n.provider,
    app: toolkit,
    holder,
    userId: holder === "person" ? vendorUserId : null,
    vendorUserId,
  });
}
const rowsFor = async (names: string[]) =>
  (
    await database
      .select({ app: brokeredConnections.app })
      .from(brokeredConnections)
      .where(inArray(brokeredConnections.app, names))
      .orderBy(asc(brokeredConnections.app))
  ).map((row) => row.app);
const trailFor = async (names: string[]) =>
  (
    await database
      .select({ app: auditEvents.targetId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "mcp.account_disconnected"),
          inArray(auditEvents.targetId, names),
        ),
      )
      .orderBy(asc(auditEvents.targetId))
  ).map((row) => row.app);

const preview = (n: ReturnType<typeof run>, toolkit: string) =>
  build(n.person, n.provider).request(
    `http://openbot.test/api/plugins/servers/${n.id(toolkit)}/connection/siblings`,
  );
const disconnect = (n: ReturnType<typeof run>, toolkit: string) =>
  build(n.person, n.provider).request(
    `http://openbot.test/api/plugins/servers/${n.id(toolkit)}/connection`,
    { method: "DELETE" },
  );

afterAll(async () => {
  await database
    .delete(brokeredConnections)
    .where(inArray(brokeredConnections.app, toolkits));
  await database.delete(mcpServers).where(
    inArray(
      mcpServers.id,
      toolkits.map((t) => `srv-${t}`),
    ),
  );
});

describe("the sibling list the confirmation shows", () => {
  test("is computed on the PAIR: another identity's app on the same provider is not named", async () => {
    const n = run();
    for (const t of [n.gmail, n.calendar, n.docs, n.slack]) await app(n, t);
    await hold(n, n.gmail, n.person);
    await hold(n, n.calendar, n.person); // same identity, same provider: a sibling
    await hold(n, n.docs, n.shared, "deployment"); // same provider, ANOTHER identity
    await hold(n, n.slack, n.person); // same identity, ANOTHER provider

    const response = await preview(n, n.gmail);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      siblings: [n.calendar],
      unanswered: 0,
    });
    // Asking changes nothing: no revoke, no row gone.
    expect(revokes).toEqual([]);
    expect(await rowsFor([n.gmail, n.calendar, n.docs, n.slack])).toEqual(
      [n.gmail, n.calendar, n.docs, n.slack].sort(),
    );
  });
});

describe("the disconnect", () => {
  test("removes and audits every app that ended, and nothing on another pair", async () => {
    const n = run();
    for (const t of [n.gmail, n.calendar, n.docs, n.slack]) await app(n, t);
    await hold(n, n.gmail, n.person);
    await hold(n, n.calendar, n.person);
    await hold(n, n.docs, n.shared, "deployment");
    await hold(n, n.slack, n.person);

    const response = await disconnect(n, n.gmail);

    expect(response.status).toBe(200);
    expect(revokes).toEqual([n.gmail]); // ONE ask to the vendor
    expect(await rowsFor([n.gmail, n.calendar, n.docs, n.slack])).toEqual(
      [n.docs, n.slack].sort(),
    );
    expect(await trailFor([n.gmail, n.calendar, n.docs, n.slack])).toEqual(
      [n.gmail, n.calendar].sort(),
    );
  });

  test("a partial vendor failure leaves EVERY row standing and audits nothing", async () => {
    const n = run();
    for (const t of [n.gmail, n.calendar]) await app(n, t);
    await hold(n, n.gmail, n.person);
    await hold(n, n.calendar, n.person);
    revokeAnswer = new Error("revoke failed halfway");

    const response = await disconnect(n, n.gmail);

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(revokes).toEqual([n.gmail]);
    expect(await rowsFor([n.gmail, n.calendar])).toEqual(
      [n.gmail, n.calendar].sort(),
    );
    expect(await trailFor([n.gmail, n.calendar])).toEqual([]);
  });

  test("answers what the vendor was asked, passing a false through unrewritten", async () => {
    const n = run();
    await app(n, n.gmail);
    await hold(n, n.gmail, n.person);
    revokeAnswer = false;

    const response = await disconnect(n, n.gmail);

    expect(await response.json()).toEqual({ vendorRevocationRequested: false });
    expect(await rowsFor([n.gmail])).toEqual([]);
  });
});

describe("Composio, where an app is its own auth provider", () => {
  test("names no siblings and disconnects exactly the one app", async () => {
    const n = run("composio");
    for (const t of [n.gmail, n.calendar]) await app(n, t);
    await hold(n, n.gmail, n.person);
    await hold(n, n.calendar, n.person);

    const listed = await preview(n, n.gmail);
    expect(await listed.json()).toEqual({ siblings: [], unanswered: 0 });

    const response = await disconnect(n, n.gmail);

    expect(response.status).toBe(200);
    expect(await rowsFor([n.gmail, n.calendar])).toEqual([n.calendar]);
    expect(await trailFor([n.gmail, n.calendar])).toEqual([n.gmail]);
  });
});
