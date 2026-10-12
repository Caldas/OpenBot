import { afterEach, describe, expect, test } from "bun:test";
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

const restores: (() => void)[] = [];
function stub(name: string, impl: (...args: unknown[]) => unknown) {
  const on = connectionsProto();
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

function listing(rows: unknown[]) {
  stub("list", () =>
    (async function* () {
      for (const r of rows) yield r;
    })(),
  );
}

describe("arcade adapter connection lifecycle", () => {
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
});
