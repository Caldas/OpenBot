import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { brokeredConnections, mcpServers } from "../src/db/schema";
import type { BrokerProvider } from "../src/plugins/access";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * `brokerProvider` is REQUIRED on `PluginStoreOptions`, and this file is the pin for both halves of
 * what that buys.
 *
 * THE TYPE HALF IS CHECKED BY `tsc`, NOT BY BUN. This one file is named in `server/tsconfig.json`'s
 * `include` for exactly that reason: `server/tests` as a whole is outside the program, so a
 * `@ts-expect-error` written here would otherwise be read by nothing and assert nothing while
 * looking like it asserted something. Run `bun run typecheck` to run that half.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const serverIds: string[] = [];
const apps: string[] = [];

afterEach(async () => {
  for (const id of serverIds.splice(0))
    await database.delete(mcpServers).where(eq(mcpServers.id, id));
  for (const app of apps.splice(0))
    await database
      .delete(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
});
afterAll(async () => {
  await database.$client.close();
});

const broker = {} as ConnectedAppBroker;

const base = {
  database,
  auditStore: createAuditStore(database),
  credentials: {} as never,
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce" as const, deny: [], allow: ["true"] }),
  broker,
  deploymentId: `acme-${suite}`,
};

function storeFor(brokerProvider: BrokerProvider) {
  return createPluginStore({ ...base, brokerProvider });
}

/*
 * THE TYPE PIN. Omitting `brokerProvider` must not compile. If the field ever goes back to being
 * optional this line stops erroring and `tsc` fails on the unused directive instead, so the pin
 * cannot rot into silence in either direction.
 */
// @ts-expect-error - brokerProvider is required: a store must name the broker it is for.
const _withoutProvider: unknown = () => createPluginStore(base);

describe("the store reads and writes its own provider's slice", () => {
  test("an arcade store writes arcade rows that only an arcade store reads back", async () => {
    const app = `Gmail${suite}`;
    const id = `required-${suite}-${randomUUID().slice(0, 6)}`;
    await database.insert(mcpServers).values({
      id,
      title: "Example",
      vendor: "arcade",
      url: `arcade://${app}`,
      provenance: "arcade",
      authScheme: "OAUTH2",
    });
    serverIds.push(id);
    apps.push(app);

    await storeFor("arcade").recordBrokeredConnection({
      toolkit: app,
      account: {
        holder: "person",
        userId: `user-${suite}`,
        vendorUserId: `vendor-${suite}`,
      },
      verified: true,
      probeAction: null,
    });

    const rows = await database
      .select({
        provider: brokeredConnections.provider,
        userId: brokeredConnections.userId,
      })
      .from(brokeredConnections)
      .where(eq(brokeredConnections.app, app));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("arcade");

    const seen = await storeFor("arcade").accountsOn(id);
    expect(seen?.toolkit).toBe(app);
    expect(seen?.accounts).toEqual([
      {
        holder: "person",
        userId: `user-${suite}`,
        vendorUserId: `vendor-${suite}`,
      },
    ]);
  });

  test("a composio store writes composio rows and does not see the arcade ones", async () => {
    const app = `gmail${suite}`;
    const id = `required-${suite}-${randomUUID().slice(0, 6)}`;
    await database.insert(mcpServers).values({
      id,
      title: "Example",
      vendor: "composio",
      url: `composio://${app}`,
      provenance: "composio",
      authScheme: "OAUTH2",
    });
    serverIds.push(id);
    apps.push(app);

    // An arcade row already filed under the same app name, which a composio store must not read.
    await database.insert(brokeredConnections).values({
      provider: "arcade",
      app,
      holder: "person",
      userId: `other-${suite}`,
      vendorUserId: `othervendor-${suite}`,
    });

    await storeFor("composio").recordBrokeredConnection({
      toolkit: app,
      account: {
        holder: "person",
        userId: `user-${suite}`,
        vendorUserId: `vendor-${suite}`,
      },
      verified: true,
      probeAction: null,
    });

    const written = await database
      .select({ userId: brokeredConnections.userId })
      .from(brokeredConnections)
      .where(
        and(
          eq(brokeredConnections.app, app),
          eq(brokeredConnections.provider, "composio"),
        ),
      );
    expect(written).toHaveLength(1);
    expect(written[0]?.userId).toBe(`user-${suite}`);

    const seen = await storeFor("composio").accountsOn(id);
    expect(seen?.accounts).toEqual([
      {
        holder: "person",
        userId: `user-${suite}`,
        vendorUserId: `vendor-${suite}`,
      },
    ]);
  });
});
