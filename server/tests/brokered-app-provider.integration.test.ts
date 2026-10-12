/**
 * `addBrokeredApp` composes the row's url, id, provenance and vendor label from the store's
 * provider, and the add-by-URL path reserves both brokers' id namespaces.
 *
 * Case is never normalised: Arcade's toolkit names are case-sensitive, so `arcade://Gmail` and
 * `arcade://gmail` are distinct apps.
 */
import { afterAll, afterEach, expect, test } from "bun:test";
import { eq, like, or } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { brokeredConnections, mcpServers } from "../src/db/schema";
import type { BrokerConnection } from "../src/plugins/broker";
import type { BrokerProvider } from "../src/plugins/access";
import type { ComposioBroker } from "../src/plugins/composio";
import {
  CustomServerRefusedError,
  createPluginStore,
} from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);

async function clean() {
  await database
    .delete(brokeredConnections)
    .where(like(brokeredConnections.app, "bap%"));
  await database
    .delete(mcpServers)
    .where(
      or(
        like(mcpServers.id, "arcade-bap%"),
        like(mcpServers.id, "composio-bap%"),
      ),
    );
}
afterEach(clean);
afterAll(async () => {
  await clean();
  await database.$client.close();
});

const unasked = (what: string) => async (): Promise<never> => {
  throw new Error(`asked the broker to ${what}`);
};

function storeFor(
  provider: BrokerProvider,
  ensure: "created" | "standing" = "created",
) {
  const broker: ComposioBroker = {
    // This stub stands in for Composio, whose grant is held locally; see `ConnectedAppBroker.grantIsLocal`.
    grantIsLocal: true,
    listApps: unasked("list"),
    ensureAuthConfig: async () => ensure,
    deleteAuthConfig: unasked("delete"),
    authorize: unasked("authorize"),
    isConnected: unasked("check"),
    revoke: unasked("revoke"),
    accountName: async () => null,
  };
  return createPluginStore({
    brokerProvider: provider,
    database,
    auditStore: createAuditStore(database),
    credentials: {
      readSecret: async () => null,
      create: async () => {
        throw new Error("vault");
      },
      updateSecret: async () => {
        throw new Error("vault");
      },
      revoke: async () => {
        throw new Error("vault");
      },
    },
    encryptionKey: "x".repeat(44),
    policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
    broker,
  });
}

const consent: BrokerConnection = { kind: "consent" };

async function row(id: string) {
  const [found] = await database
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, id));
  return found;
}

test("an Arcade store enables an arcade:// toolkit under an arcade- id, case kept", async () => {
  const store = storeFor("arcade");
  const record = await store.addBrokeredApp({
    slug: "bapGmail",
    title: "Gmail",
    by: "admin@example.com",
    connection: consent,
  });
  expect(record.id).toBe("arcade-bapGmail");
  expect(record.url).toBe("arcade://bapGmail");
  expect(record.provenance).toBe("arcade");
  const stored = await row("arcade-bapGmail");
  expect(stored?.vendor).toBe("Arcade");
  expect(stored?.provenance).toBe("arcade");
  expect(await row("composio-bapGmail")).toBeUndefined();

  // Distinct apps: the lower-case spelling is its own row, not the same one.
  await store.addBrokeredApp({
    slug: "bapgmail",
    title: "gmail",
    by: "admin@example.com",
    connection: consent,
  });
  expect((await row("arcade-bapgmail"))?.url).toBe("arcade://bapgmail");
  expect((await row("arcade-bapGmail"))?.url).toBe("arcade://bapGmail");
});

test("a Composio store still enables a composio:// app under a composio- id", async () => {
  const store = storeFor("composio");
  const record = await store.addBrokeredApp({
    slug: "bapslack",
    title: "Slack",
    by: "admin@example.com",
    connection: consent,
  });
  expect(record.id).toBe("composio-bapslack");
  expect(record.url).toBe("composio://bapslack");
  expect(record.provenance).toBe("composio");
  expect((await row("composio-bapslack"))?.vendor).toBe("Composio");
  expect(await row("arcade-bapslack")).toBeUndefined();
});

test("each store refuses a slug its own parser cannot read, naming its own vendor", async () => {
  await expect(
    storeFor("arcade").addBrokeredApp({
      slug: "bap.Dotted",
      title: "x",
      by: "admin@example.com",
      connection: consent,
    }),
  ).rejects.toThrow(/^bap\.Dotted is not a name an Arcade app can have\./);
  await expect(
    storeFor("composio").addBrokeredApp({
      slug: "bap dotted",
      title: "x",
      by: "admin@example.com",
      connection: consent,
    }),
  ).rejects.toThrow(/^bap dotted is not a name a Composio app can have\./);
  expect(await row("arcade-bap.Dotted")).toBeUndefined();
  expect(await row("composio-bap dotted")).toBeUndefined();
});

test("re-enabling over a connected Arcade app keeps the recorded scheme", async () => {
  // The connection check reads the STORE'S provider: a composio filter would see no connection
  // here, treat the re-add as free to rewrite, and move the scheme under a live account.
  const store = storeFor("arcade", "created");
  await store.addBrokeredApp({
    slug: "bapkept",
    title: "Kept",
    by: "admin@example.com",
    connection: { kind: "fields", authScheme: "API_KEY" } as BrokerConnection,
  });
  const before = (await row("arcade-bapkept"))?.authScheme;
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app: "bapkept",
    holder: "deployment",
    vendorUserId: "deployment",
  });
  await store.addBrokeredApp({
    slug: "bapkept",
    title: "Kept",
    by: "admin@example.com",
    connection: consent,
  });
  expect((await row("arcade-bapkept"))?.authScheme).toBe(before ?? null);
});

for (const provider of ["composio", "arcade"] as const) {
  for (const prefix of ["composio-", "arcade-"]) {
    test(`a ${provider} store refuses a URL-added server named ${prefix}x`, async () => {
      const id = `${prefix}bapx`;
      const vendor = prefix === "arcade-" ? "Arcade" : "Composio";
      await expect(
        storeFor(provider).addCustomServer({
          id,
          title: "Collector",
          url: "https://collector.example/mcp",
          by: "admin@example.com",
        }),
      ).rejects.toThrow(
        new CustomServerRefusedError(
          `Names beginning ${prefix} belong to the ${vendor} apps this deployment enables, so ${id} is not a name a server added by URL can take. Choose another.`,
        ).message,
      );
      expect(await row(id)).toBeUndefined();
    });
  }
}
