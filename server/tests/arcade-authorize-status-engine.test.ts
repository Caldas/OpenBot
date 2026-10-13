import { afterEach, describe, expect, test } from "bun:test";
import { useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import { BrokerRefusalError } from "../src/plugins/broker";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * WHAT THE VENDOR SAID ABOUT THE AUTHORIZATION IT JUST MINTED, READ OFF A REAL HTTP ANSWER.
 *
 * The rest of the authorize suite replaces `Tools.prototype.authorize` with a function returning a
 * hand-built object. That is blind to this class: the stub returns whatever shape the test chose,
 * so it cannot show what happens when the LIVE engine answers `{"status":"completed"}` — the answer
 * Arcade gives when the account already holds this grant — or `{"status":"failed"}`. This file
 * serves those answers as JSON over a socket through `ARCADE_BASE_URL`, exactly as
 * `arcade-pagination-engine.test.ts` does, and `new Arcade({ apiKey })` reads that variable at
 * construction, which is why the engine starts BEFORE `createArcadeClient`.
 */

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

type EngineOptions = {
  /** The `status` the mint answers with; `null` OMITS the field, as the wire may. */
  status: string | null;
  /** Whether the mint answers a consent url beside it. */
  url?: string | null;
};

type Engine = { port: number; stop: () => void };

function startEngine(options: EngineOptions): Engine {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/tools/authorize") {
        const body: Record<string, unknown> = { id: "ar_mint1" };
        if (options.status !== null) body.status = options.status;
        const consent =
          options.url === undefined
            ? "https://consent.example/go"
            : options.url;
        if (consent !== null) body.url = consent;
        return Response.json(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

let running: Engine | null = null;
const wasBaseURL = process.env.ARCADE_BASE_URL;

function engine(options: EngineOptions): Engine {
  running = startEngine(options);
  process.env.ARCADE_BASE_URL = `http://localhost:${running.port}`;
  return running;
}

afterEach(() => {
  running?.stop();
  running = null;
  useArcadeClient(null);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

const mint = () =>
  createArcadeClient("never-dialled").broker.authorize({
    account,
    toolkit: "Gmail",
    action: "Gmail.SendEmail",
    returnUrl: "https://openbot.example/settings/plugins",
  });

describe("the mint reads the status Arcade answered with", () => {
  test("a pending mint is handed on, which is the whole of the happy path", async () => {
    engine({ status: "pending" });
    expect(await mint()).toEqual({
      redirectUrl: "https://consent.example/go",
      authorizationId: "ar_mint1",
    });
  });

  test("an answer with NO status is handed on: silence is not a no", async () => {
    engine({ status: null });
    expect(await mint()).toEqual({
      redirectUrl: "https://consent.example/go",
      authorizationId: "ar_mint1",
    });
  });

  test("a mint the vendor calls completed does not send anybody to a consent screen", async () => {
    // Arcade answers this for an account that already holds the grant, and it answers it WITH a
    // url: the defect is not an absent url, so the url guard below cannot stand in for this.
    engine({ status: "completed" });
    await expect(mint()).rejects.toBeInstanceOf(BrokerRefusalError);
    await expect(mint()).rejects.toThrow(/already/i);
  });

  test("a mint the vendor calls failed is not handed on as a live redirect", async () => {
    engine({ status: "failed" });
    await expect(mint()).rejects.toBeInstanceOf(BrokerRefusalError);
    await expect(mint()).rejects.toThrow(/failed/);
  });

  test("a status this deployment does not know is not read as consent-is-next", async () => {
    // The spelling is not in the SDK's declared union at all. An allowlist refuses it; a denylist
    // of the dead spellings would hand its url to a browser.
    engine({ status: "revoked" });
    await expect(mint()).rejects.toBeInstanceOf(BrokerRefusalError);
  });

  test("the status is read case- and space-insensitively, as every other comparison here is", async () => {
    engine({ status: "  Completed " });
    await expect(mint()).rejects.toBeInstanceOf(BrokerRefusalError);
  });
});
