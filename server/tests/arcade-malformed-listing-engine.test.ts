import { afterEach, describe, expect, test } from "bun:test";
import { listTools, useArcadeClient } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * EVERY "Arcade did not answer with a list" SENTENCE, AGAINST A REAL HTTP ENGINE.
 *
 * These guards cannot be tested in the style of the rest of the adapter suite, which stubs the
 * SDK's resource PROTOTYPES and so decides for itself what the adapter is handed. The defect they
 * exist for lives BETWEEN the wire and the adapter: `OffsetPage`'s constructor does
 * `this.items = body.items || []`, so an answer that carries no `items` at all reaches a reader of
 * the PAGE OBJECT as an empty array — a malformed listing wearing an empty one's clothes. A stub
 * that hands the adapter its own object never manufactures that default, so a test in that style
 * passes whether the guard reads the page or the body it was built from.
 *
 * So, as in `arcade-pagination-engine.test.ts`, the engine here serves real JSON over a real socket
 * through `ARCADE_BASE_URL` and the SDK builds its own pages. The malformed body is `{"error":
 * "nope"}`: a well-formed JSON object, 200, with no `items` — what an engine answering an error
 * shape on the success path sends.
 */

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

/** Which of the three listings answers the malformed body. */
type Malformed = "tools" | "connections" | "authProviders";

type Engine = { port: number; stop: () => void };

const MALFORMED = { error: "nope" };

const toolRow = (toolkit: string) => ({
  qualified_name: `${toolkit}.Action0`,
  description: "",
  toolkit: { name: toolkit, description: "" },
  input: { parameters: [] },
  requirements: {
    authorization: { provider_id: "google", oauth2: { scopes: [] } },
  },
});

function startEngine(malformed: Malformed): Engine {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const offset = Number(url.searchParams.get("offset") ?? "0");

      if (url.pathname === "/v1/admin/user_connections") {
        if (malformed === "connections") return Response.json(MALFORMED);
        return Response.json({ items: [], offset, limit, page_count: 0 });
      }
      if (url.pathname === "/v1/admin/auth_providers") {
        if (malformed === "authProviders") return Response.json(MALFORMED);
        return Response.json({
          items: [
            { id: "google-openbot", provider_id: "google", type: "oauth2" },
          ],
          offset: 0,
          limit,
          page_count: 1,
          total_count: 1,
        });
      }
      if (url.pathname === "/v1/tools") {
        if (malformed === "tools") return Response.json(MALFORMED);
        const toolkit = url.searchParams.get("toolkit") ?? "Gmail";
        const page = offset === 0 ? [toolRow(toolkit)] : [];
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

function engine(malformed: Malformed): void {
  running = startEngine(malformed);
  process.env.ARCADE_BASE_URL = `http://localhost:${running.port}`;
}

afterEach(() => {
  running?.stop();
  running = null;
  useArcadeClient(null);
  if (wasBaseURL === undefined) delete process.env.ARCADE_BASE_URL;
  else process.env.ARCADE_BASE_URL = wasBaseURL;
});

describe("a listing with no items refuses rather than reading as empty", () => {
  test("listApps refuses a tool listing that is not a list", async () => {
    engine("tools");
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.listApps()).rejects.toThrow(
      /Arcade did not answer with a tool list/,
    );
  });

  test("grantsFor refuses a tool listing that is not a list", async () => {
    engine("tools");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.grantsFor({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/Arcade did not answer with an action list for Gmail/);
  });

  test("isConnected refuses a tool listing that is not a list", async () => {
    // Through `authProviderOf`, the one unpaged listing in the adapter.
    engine("tools");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(
      /Arcade did not answer with an action list for Gmail, so the auth provider/,
    );
  });

  test("the transport refuses a tool listing that is not a list", async () => {
    engine("tools");
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);

    await expect(listTools({ url: "arcade://Gmail" })).rejects.toThrow(
      /Arcade did not answer with an action list for Gmail\. Nothing was refreshed/,
    );
  });

  test("isConnected refuses an auth-provider listing that is not a list", async () => {
    engine("authProviders");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/Arcade did not answer with an auth-provider list/);
  });

  test("isConnected refuses a connection listing that is not a list", async () => {
    engine("connections");
    const { broker } = createArcadeClient("never-dialled");

    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/Arcade did not answer with a connection list/);
  });

  test("revoke refuses a connection listing that is not a list", async () => {
    engine("connections");
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /Arcade did not answer with a connection list/,
    );
  });
});
