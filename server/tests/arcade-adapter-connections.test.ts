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

const row = (n: number, provider: string, info?: unknown) => ({
  id: `at_${n}`,
  connection_id: `ac_${n}`,
  provider_id: provider,
  provider_user_info: info,
});

/**
 * What the toolkit's listing says its auth provider is, keyed by the toolkit asked about. A toolkit
 * absent from the map is answered by a listing that names no provider, i.e. UNRESOLVED. Counts the
 * listing reads so a test can pin that a call resolves once.
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

function listing(rows: unknown[]) {
  stub("list", () =>
    (async function* () {
      for (const r of rows) yield r;
    })(),
  );
}

/** The world every earlier case lived in: each provider is named after its own toolkit. */
const NAMED_AFTER_TOOLKIT = {
  Github: "github",
  GitHub: "github",
  Google: "google",
};

describe("arcade adapter connection lifecycle", () => {
  beforeEach(() => {
    providers(NAMED_AFTER_TOOLKIT);
  });

  test("isConnected is true on a non-empty list and false on an empty one", async () => {
    const rows: unknown[] = [row(1, "github")];
    listing(rows);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(true);
    rows.length = 0;
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(
      false,
    );
  });

  test("isConnected ignores another app's connection", async () => {
    listing([row(1, "google")]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Github" })).toBe(
      false,
    );
  });

  test("delete is passed the ac_ connection_id, never the at_ id", async () => {
    listing([row(7, "github")]);
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
    listing([row(1, "google")]);
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
    listing([row(1, "github"), row(2, "github"), row(3, "github")]);
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
      row(1, "github", {}),
      row(2, "google", { name: "Grace" }),
      row(3, "github", { name: "Ada" }),
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
    listing([row(1, "github", {}), row(2, "google", { name: "Grace" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.accountName({ account, toolkit: "Github" })).toBeNull();
  });

  test("a Gmail row under provider `google` is FOUND by all three members", async () => {
    providers({ Gmail: "google" });
    listing([row(4, "google", { name: "Grace" })]);
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
    expect(deleted).toEqual(["ac_4"]);
  });

  test("the provider is compared case-insensitively", async () => {
    providers({ Gmail: "Google" });
    listing([row(4, "google", { name: "Grace" })]);
    const { broker } = createArcadeClient("never-dialled");
    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
  });

  test("a different provider on the same identity is still excluded", async () => {
    providers({ Gmail: "google" });
    listing([row(1, "github", { name: "Ada" }), row(2, "google", {})]);
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
    listing([row(1, "gmail")]);
    const { broker } = createArcadeClient("never-dialled");
    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /action list/,
    );
  });

  test("each call resolves the provider once, however many rows there are", async () => {
    const asked = providers({ Gmail: "google" });
    listing([row(1, "google"), row(2, "google"), row(3, "google")]);
    stub("delete", () => Promise.resolve());
    const { broker } = createArcadeClient("never-dialled");
    await broker.revoke({ account, toolkit: "Gmail" });
    expect(asked).toHaveLength(1);
  });
});
