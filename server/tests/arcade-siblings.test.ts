// server/tests/arcade-siblings.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { brokeredConnections } from "../src/db/schema";
import type { ConnectedAppBroker } from "../src/plugins/broker";
import { mintDeploymentVendorUserId } from "../src/plugins/shared-accounts";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const suite = randomUUID().slice(0, 8);
const gmail = `Gmail-${suite}`;
const calendar = `GoogleCalendar-${suite}`;
const slack = `Slack-${suite}`;
const lonely = `Lonely-${suite}`;

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
  grantsFor: async () => [],
  listApps: async () => [],
  ensureAuthConfig: async () => "standing",
  deleteAuthConfig: async () => {},
  authorize: async () => ({
    redirectUrl: "https://vendor.example/consent",
    authorizationId: "ar_1",
  }),
  isConnected: async () => true,
  revoke: async () => true,
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

// Which vendor provider each app's connection is held at, as the adapter reads it off the vendor's
// own listing. Gmail and Calendar are Google; Slack is Slack.
const providerOf: Record<string, string> = {
  [gmail]: "google",
  [calendar]: "google",
  [slack]: "slack",
  [lonely]: "google",
};
const providerIdOf = async (toolkit: string) => providerOf[toolkit] ?? null;

const seeded: string[] = [];
async function holdShared(app: string, vendorUserId: string) {
  seeded.push(app);
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app,
    holder: "deployment",
    vendorUserId,
  });
}
async function holdPersonal(app: string, userId: string) {
  seeded.push(app);
  await database.insert(brokeredConnections).values({
    provider: "arcade",
    app,
    holder: "person",
    userId,
    vendorUserId: userId,
  });
}

afterEach(async () => {
  if (seeded.length)
    await database
      .delete(brokeredConnections)
      .where(inArray(brokeredConnections.app, seeded));
  seeded.length = 0;
});

describe("revocation siblings are keyed on (vendor identity, provider_id)", () => {
  test("two Shared apps on the same provider with DIFFERENT minted identities are not siblings", async () => {
    const gmailIdentity = mintDeploymentVendorUserId(`acme-${suite}`);
    const calendarIdentity = mintDeploymentVendorUserId(`acme-${suite}`);
    expect(gmailIdentity).not.toBe(calendarIdentity);
    await holdShared(gmail, gmailIdentity);
    await holdShared(calendar, calendarIdentity);

    expect(
      await store.siblingApps({
        toolkit: gmail,
        account: { holder: "deployment", vendorUserId: gmailIdentity },
        providerIdOf,
      }),
    ).toEqual([]);
  });

  test("two apps genuinely sharing the pair are siblings, and an app on another provider is not", async () => {
    const userId = `person-${suite}`;
    await holdPersonal(gmail, userId);
    await holdPersonal(calendar, userId);
    await holdPersonal(slack, userId);

    expect(
      await store.siblingApps({
        toolkit: gmail,
        account: { holder: "person", userId, vendorUserId: userId },
        providerIdOf,
      }),
    ).toEqual([calendar]);
  });

  test("an app with no co-tenant has an empty list, never itself", async () => {
    const userId = `solo-${suite}`;
    await holdPersonal(lonely, userId);

    expect(
      await store.siblingApps({
        toolkit: lonely,
        account: { holder: "person", userId, vendorUserId: userId },
        providerIdOf,
      }),
    ).toEqual([]);
  });
});
