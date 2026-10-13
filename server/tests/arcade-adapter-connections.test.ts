import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Arcade from "@arcadeai/arcadejs";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

/** Prototype stubs BEFORE construction; `new Arcade({ apiKey })` opens no socket. */
type Methods = Record<string, (...args: unknown[]) => unknown>;
const connectionsProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).admin.userConnections,
  ) as Methods;

const toolsProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).tools,
  ) as Methods;

const authProvidersProto = (): Methods =>
  Object.getPrototypeOf(
    new Arcade({ apiKey: "never-dialled" }).admin.authProviders,
  ) as Methods;

const restores: (() => void)[] = [];
function stub(
  name: string,
  impl: (...args: unknown[]) => unknown,
  on: Methods = connectionsProto(),
) {
  const was = on[name];
  on[name] = impl;
  restores.push(() => {
    on[name] = was;
  });
}
afterEach(() => {
  while (restores.length) restores.pop()?.();
  useArcadeClient(null);
});

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

/**
 * One user-connection row, whose `provider_id` is a provider INSTANCE id and NEVER a provider type.
 *
 * That is the live shape, and it is the whole subject of this file: on a tool listing
 * `provider_id` is the TYPE (`google`), on a connection row it is the operator's CONFIGURATION of
 * that type (`google-openbot`, `arcade-google`, `cpk-poc`). A fixture spelling both sides alike —
 * which every fixture here once did — makes the two meanings coincide and hides a comparison that
 * matches nothing on any real deployment.
 */
const row = (n: number, instance: string, info?: unknown) => ({
  id: `at_${n}`,
  connection_id: `ac_${n}`,
  provider_id: instance,
  provider_user_info: info,
});

/**
 * What the toolkit's listing says its auth provider TYPE is, keyed by the toolkit asked about. A
 * toolkit absent from the map is answered by a listing that names no provider, i.e. UNRESOLVED.
 * Counts the listing reads so a test can pin that a call resolves once.
 */
function providers(byToolkit: Record<string, string>) {
  const asked: unknown[] = [];
  stub(
    "list",
    (query) => {
      asked.push(query);
      const toolkit = (query as { toolkit: string }).toolkit;
      const provider = byToolkit[toolkit];
      return Promise.resolve({
        items: [
          {
            qualified_name: `${toolkit}.A`,
            requirements: {
              authorization: {
                id: "x",
                ...(provider ? { provider_id: provider } : {}),
              },
            },
          },
        ],
      });
    },
    toolsProto(),
  );
  return asked;
}

/**
 * The project's configured auth providers, verbatim in shape from the live project: `id` is the
 * INSTANCE and `provider_id` is the TYPE. Two instances share the type `google` on purpose — an
 * operator's own and one of Arcade's defaults — because a person may hold a connection under
 * either and reducing the type to one instance would drop one of them.
 */
const CONFIGS = [
  { id: "cpk-poc", provider_id: "github", type: "oauth2", status: "active" },
  {
    id: "google-openbot",
    provider_id: "google",
    type: "oauth2",
    status: "active",
  },
  {
    id: "arcade-google",
    provider_id: "google",
    type: "oauth2",
    status: "active",
  },
];

/** Counts the configuration reads, so a test can pin that a call reads them once. */
function configs(items: unknown[] = CONFIGS) {
  const asked: unknown[] = [];
  stub(
    "list",
    (options) => {
      asked.push(options);
      return Promise.resolve({ items, total_count: items.length });
    },
    authProvidersProto(),
  );
  return asked;
}

function listing(rows: unknown[]) {
  stub("list", () =>
    (async function* () {
      for (const r of rows) yield r;
    })(),
  );
}

/** The TYPE each toolkit's listing names. Nothing here is an instance id. */
const TOOLKIT_TYPES = {
  Github: "github",
  GitHub: "github",
  Google: "google",
  Gmail: "google",
};

describe("arcade adapter connection lifecycle", () => {
  beforeEach(() => {
    providers(TOOLKIT_TYPES);
    configs();
  });

  test("isConnected is true on a non-empty list and false on an empty one", async () => {
    const rows: unknown[] = [row(1, "cpk-poc")];
    listing(rows);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(true);
    rows.length = 0;
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(
      false,
    );
  });

  test("isConnected ignores another app's connection", async () => {
    listing([row(1, "google-openbot")]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(
      false,
    );
  });

  test("delete is passed the ac_ connection_id, never the at_ id", async () => {
    listing([row(7, "cpk-poc")]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.revoke({ account, toolkit: "Github" })).toBe(true);
    expect(deleted).toEqual(["ac_7"]);
    expect(String(deleted[0]).startsWith("at_")).toBe(false);
  });

  test("revokeAccount deletes by the id it is handed", async () => {
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    await broker.revokeAccount("ac_9");
    expect(deleted).toEqual(["ac_9"]);
  });

  test("revoke answers false on nothing-found and deletes nothing", async () => {
    listing([row(1, "google-openbot")]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.revoke({ account, toolkit: "Github" })).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("revoke THROWS when one of several deletes fails, after trying them all", async () => {
    listing([row(1, "cpk-poc"), row(2, "cpk-poc"), row(3, "cpk-poc")]);
    const tried: unknown[] = [];
    stub("delete", (id) => {
      tried.push(id);
      return id === "ac_2"
        ? Promise.reject(new Error("500"))
        : Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    let outcome: unknown = "returned";
    try {
      outcome = await broker.revoke({ account, toolkit: "Github" });
    } catch (error) {
      outcome = error;
    }
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/1 of 3/);
    expect(tried).toEqual(["ac_1", "ac_2", "ac_3"]);
  });

  test("accountName never answers another app's name", async () => {
    listing([
      row(1, "cpk-poc", {}),
      row(2, "google-openbot", { name: "Grace" }),
      row(3, "cpk-poc", { name: "Ada" }),
    ]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.accountName({ account, toolkit: "GitHub" })).toBe(
      "Ada",
    );
    expect(await broker.accountName({ account, toolkit: "Google" })).toBe(
      "Grace",
    );
  });

  test("accountName is null, not the second app's name, when the first carries none", async () => {
    listing([
      row(1, "cpk-poc", {}),
      row(2, "google-openbot", { name: "Grace" }),
    ]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.accountName({ account, toolkit: "Github" })).toBeNull();
  });

  /*
   * THE DEFECT THIS FILE EXISTS FOR, AT ITS THREE MEMBERS. `Gmail` names the TYPE `google`; the
   * connection is held under the INSTANCE `google-openbot`. A comparison of the two raw strings
   * finds nothing — and `revoke` then answers false WITHOUT SPENDING A DELETE, so the vendor
   * connection outlives the Disconnect that was supposed to end it.
   */
  test("a Gmail connection under the custom instance `google-openbot` is FOUND by all three members", async () => {
    listing([row(4, "google-openbot", { name: "Grace" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    expect(await broker.isConnected({ account, toolkit })).toBe(true);
    expect(await broker.accountName({ account, toolkit })).toBe("Grace");
    expect(await broker.revoke({ account, toolkit })).toBe(true);
    // The `ac_…` connection_id, never the `at_…` row id.
    expect(deleted).toEqual(["ac_4"]);
  });

  test("a Gmail connection under Arcade's DEFAULT instance `arcade-google` is found too", async () => {
    listing([row(5, "arcade-google", { name: "Ada" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    expect(await broker.isConnected({ account, toolkit })).toBe(true);
    expect(await broker.accountName({ account, toolkit })).toBe("Ada");
    expect(await broker.revoke({ account, toolkit })).toBe(true);
    expect(deleted).toEqual(["ac_5"]);
  });

  test("BOTH instances of one type are matched; neither is dropped for the other", async () => {
    listing([row(4, "google-openbot"), row(5, "arcade-google")]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(true);
    expect(deleted.sort()).toEqual(["ac_4", "ac_5"]);
  });

  test("an UNRELATED instance (`cpk-poc`, type github) is not a Gmail connection", async () => {
    listing([row(1, "cpk-poc", { name: "Ada" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    expect(await broker.isConnected({ account, toolkit })).toBe(false);
    expect(await broker.accountName({ account, toolkit })).toBeNull();
    expect(await broker.revoke({ account, toolkit })).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("the TYPE itself is not an instance id, so a row spelled `google` is not matched", async () => {
    // Nothing anywhere falls back to comparing the raw type against a row.
    listing([row(6, "google", { name: "Grace" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(false);
  });

  test("an instance the configuration list does not name is fail-closed, not deleted", async () => {
    // A provider configuration deleted while a connection outlived it.
    listing([row(8, "retired-google", { name: "Grace" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("both the type and the instance are compared case-insensitively", async () => {
    providers({ Gmail: "GOOGLE" });
    configs([{ id: "Google-OpenBot", provider_id: "Google" }]);
    listing([row(4, "google-openbot", { name: "Grace" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
  });

  test("a different provider on the same identity is still excluded", async () => {
    listing([row(1, "cpk-poc", { name: "Ada" }), row(2, "google-openbot", {})]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBeNull();
    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(true);
    expect(deleted).toEqual(["ac_2"]);
  });

  test("an UNRESOLVED toolkit answers as no rows and never falls back to its name", async () => {
    // `Gmail` is unresolved, and a row whose provider IS literally `gmail` exists: a fallback to
    // the toolkit name would find it.
    providers({});
    listing([row(1, "gmail", { name: "Grace" })]);
    const deleted: unknown[] = [];
    stub("delete", (id) => {
      deleted.push(id);
      return Promise.resolve();
    });
    const { broker } = createArcadeClient("never-dialled");
    const toolkit = "Gmail";
    expect(await broker.isConnected({ account, toolkit })).toBe(false);
    expect(await broker.accountName({ account, toolkit })).toBeNull();
    expect(await broker.revoke({ account, toolkit })).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("a malformed listing THROWS out of the lifecycle members rather than answering no rows", async () => {
    stub("list", () => Promise.resolve({ items: "nope" }), toolsProto());
    listing([row(1, "google-openbot")]);
    const { broker } = createArcadeClient("never-dialled");
    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /action list/,
    );
  });

  test("a malformed auth-provider listing THROWS rather than answering no rows", async () => {
    stub(
      "list",
      () => Promise.resolve({ items: "nope" }),
      authProvidersProto(),
    );
    listing([row(1, "google-openbot")]);
    const { broker } = createArcadeClient("never-dialled");
    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /auth-provider list/,
    );
  });

  test("each call resolves the provider and its configurations once, however many rows", async () => {
    const asked = providers({ Gmail: "google" });
    const read = configs();
    listing([
      row(1, "google-openbot"),
      row(2, "google-openbot"),
      row(3, "arcade-google"),
    ]);
    stub("delete", () => Promise.resolve());
    const { broker } = createArcadeClient("never-dialled");
    await broker.revoke({ account, toolkit: "Gmail" });
    expect(asked).toHaveLength(1);
    expect(read).toHaveLength(1);
  });
});
