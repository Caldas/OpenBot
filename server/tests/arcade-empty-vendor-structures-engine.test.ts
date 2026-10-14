import { afterEach, describe, expect, test } from "bun:test";
import { listTools, useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * AN EMPTY VENDOR STRUCTURE IS NOT A VENDOR ANSWER, AGAINST A REAL HTTP ENGINE.
 *
 * `metadata: { behavior: {} }` and `requirements: { secrets: {} }` are containers Arcade opened and
 * put nothing in. Read as answers they say "not destructive" and "nothing is required" — a
 * permission decision taken on missing data, and the opposite of what an ABSENT `metadata` or an
 * absent `behavior` already answers two lines away in the same function.
 *
 * SERVED OVER A REAL SOCKET, as `arcade-pagination-engine.test.ts` and
 * `arcade-malformed-listing-engine.test.ts` are and for their reason: the rest of the adapter suite
 * stubs the SDK's resource PROTOTYPES and so decides for itself what the adapter is handed, which
 * cannot see anything that happens between the wire and the reader. Here the SDK parses the body
 * and builds its own pages, so what these assertions read is what a deployment would.
 */

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

type Engine = { port: number; stop: () => void };

/** The rows `/v1/tools` serves, set per test. One short page ends the listing. */
let serving: unknown[] = [];

function startEngine(): Engine {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (url.pathname === "/v1/tools") {
        const page = serving.slice(offset, offset + limit);
        return Response.json({
          items: page,
          offset,
          limit,
          page_count: page.length,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(rows: unknown[]): void {
  serving = rows;
  running = startEngine();
  process.env.ARCADE_BASE_URL = `http://localhost:${running.port}`;
}

afterEach(() => {
  running?.stop();
  running = null;
  serving = [];
  useArcadeClient(null);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

/** One listed action, with whatever `metadata` and `requirements` the case is about. */
const toolRow = (
  name: string,
  metadata: unknown,
  requirements: unknown = {
    authorization: {
      provider_id: "google",
      oauth2: { scopes: [] },
      token_status: "completed",
    },
  },
) => ({
  qualified_name: `Gmail.${name}`,
  description: "",
  toolkit: { name: "Gmail", description: "" },
  input: { parameters: [] },
  metadata,
  requirements,
});

const listed = async () => {
  const { actions } = createArcadeClient("never-dialled");
  useArcadeClient(actions);
  return await listTools({ url: "arcade://Gmail" });
};

describe("an empty behavior object is the vendor saying nothing, not saying safe", () => {
  test("a behavior object stating neither flag is read as the closed verdict", async () => {
    engine([toolRow("EmptyBehavior", { behavior: {} })]);

    expect(await listed()).toMatchObject([
      { name: "Gmail.EmptyBehavior", effect: "write", destructive: true },
    ]);
  });

  test("a behavior object carrying only unrelated keys says nothing either", async () => {
    engine([toolRow("Idempotent", { behavior: { idempotent: true } })]);

    expect(await listed()).toMatchObject([
      { name: "Gmail.Idempotent", effect: "write", destructive: true },
    ]);
  });

  test("an empty behavior does not count towards classifiedCount", async () => {
    engine([
      toolRow("EmptyBehavior", { behavior: {} }),
      toolRow("Annotated", {
        behavior: { read_only: true, destructive: false },
      }),
    ]);
    const { broker } = createArcadeClient("never-dialled");

    const apps = await broker.listApps();
    expect(apps.length).toBe(1);
    expect(apps[0]?.actionCount).toBe(2);
    // ONE of the two: the empty container is an action Arcade has not classified, which is exactly
    // what the coverage warning exists to name.
    expect(apps[0]?.classifiedCount).toBe(1);
  });

  test("a stated behaviour is still read, in both directions", async () => {
    engine([
      toolRow("Read", { behavior: { read_only: true } }),
      toolRow("Write", { behavior: { destructive: false, read_only: false } }),
      toolRow("Delete", { behavior: { destructive: true } }),
    ]);

    expect(await listed()).toMatchObject([
      { name: "Gmail.Read", effect: "read", destructive: false },
      { name: "Gmail.Write", effect: "write", destructive: false },
      { name: "Gmail.Delete", effect: "write", destructive: true },
    ]);
  });
});

describe("a secrets requirement that is not a list is unreadable, not satisfied", () => {
  const withSecrets = (secrets: unknown) =>
    toolRow(
      "Send",
      { behavior: { read_only: true } },
      {
        secrets,
        authorization: {
          provider_id: "google",
          oauth2: { scopes: [] },
          token_status: "completed",
        },
      },
    );

  test("an empty secrets object does not answer authorized", async () => {
    engine([withSecrets({})]);
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.grantsFor({ account, toolkit: "Gmail" })).toEqual([
      {
        action: "Gmail.Send",
        state: "unknown",
        reason:
          "Arcade listed this action's deployment secrets as something other than a list, so whether any is unset could not be read.",
      },
    ]);
  });

  test("no secrets field at all is still no secrets required", async () => {
    engine([toolRow("Send", { behavior: { read_only: true } })]);
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.grantsFor({ account, toolkit: "Gmail" })).toEqual([
      {
        action: "Gmail.Send",
        state: "authorized",
        scopes: [],
        authorization: "held",
      },
    ]);
  });

  test("a listed secret is still read, met or unset", async () => {
    engine([withSecrets([{ key: "GITHUB_SERVER_URL", met: false }])]);
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.grantsFor({ account, toolkit: "Gmail" })).toEqual([
      {
        action: "Gmail.Send",
        state: "needs-operator",
        missing: ["GITHUB_SERVER_URL"],
      },
    ]);
  });
});
