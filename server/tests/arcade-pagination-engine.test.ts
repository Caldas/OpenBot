import { afterEach, describe, expect, test } from "bun:test";
import { useArcadeClient } from "../src/plugins/arcade";
import { listTools } from "../src/plugins/arcade";
import { createArcadeClient } from "../src/plugins/arcade-adapter";
import type { AccountRef } from "../src/plugins/shared-accounts";

/**
 * THE ADAPTER AGAINST A REAL HTTP ENGINE, BECAUSE NOTHING LESS CAN SEE THIS CLASS OF DEFECT.
 *
 * The rest of the adapter suite stubs the SDK's resource PROTOTYPES and hands the adapter a bare
 * async generator in place of a `PagePromise`. That substitution is exactly what hides the bug this
 * file is about: the real `OffsetPage` constructor does `this.total_count = body.total_count || 0`
 * and `nextPageRequestOptions()` returns `null` on a falsy total, so an engine that OMITS
 * `total_count` ends the SDK's own auto-pagination after page one AND disables every
 * `seen < total` cross-check — while a hand-written generator paginates perfectly and reports
 * whatever total the fixture chose to carry.
 *
 * So these tests serve real JSON over a real socket through `ARCADE_BASE_URL` and let the SDK build
 * its own pages. `new Arcade({ apiKey })` reads that variable at construction, which is why the
 * server is started BEFORE `createArcadeClient`.
 */

const account: AccountRef = {
  holder: "person",
  userId: "u1",
  vendorUserId: "vendor-u1",
};

type EngineOptions = {
  /** How many connection rows the engine holds. */
  connections: number;
  /** Send `total_count` on the connection listing at all? */
  connectionTotal: boolean;
  /** Serve this many connection rows and no more, while still reporting the full `total_count`. */
  connectionTruncateAt?: number;
  /**
   * The `connection_status` each row carries, row by row: a string is sent verbatim, `null` OMITS
   * the field as the wire may (the SDK declares it optional), and a row this does not reach carries
   * the live `"active"` the live API answers with.
   */
  connectionStatuses?: (string | null)[];
  /** The toolkit listing claims this many actions... */
  toolsClaimed?: number;
  /** ...and serves only this many, dropping `total_count` from the short final page. */
  toolsServed?: number;
};

type Engine = {
  port: number;
  /** Every path+query the SDK asked for, in order. */
  requests: string[];
  stop: () => void;
};

const connectionRow = (n: number, status: string | null = "active") => ({
  id: `at_${n}`,
  connection_id: `ac_${n}`,
  // OMITTED when the engine says `null`, as the wire may omit it.
  ...(status === null ? {} : { connection_status: status }),
  // A provider INSTANCE id, never a provider type: see arcade-adapter-connections.test.ts.
  provider_id: "google-openbot",
  provider_type: "oauth2",
  provider_user_info: { name: `person ${n}` },
  scopes: [],
  user_id: account.vendorUserId,
});

const toolRow = (toolkit: string, n: number) => ({
  qualified_name: `${toolkit}.Action${n}`,
  description: "",
  toolkit: { name: toolkit, description: "" },
  input: { parameters: [] },
  requirements: {
    authorization: { provider_id: "google", oauth2: { scopes: [] } },
  },
});

function statusOf(options: EngineOptions, n: number): string | null {
  const listed = options.connectionStatuses?.[n];
  return listed === undefined ? "active" : listed;
}

function startEngine(options: EngineOptions): Engine {
  const requests: string[] = [];
  const rows = Array.from({ length: options.connections }, (_, n) =>
    // `undefined` (unlisted) is the live default; `null` means OMIT the field, so it is kept apart.
    connectionRow(n, statusOf(options, n)),
  );
  const served = options.connectionTruncateAt ?? rows.length;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");

      if (url.pathname.startsWith("/v1/admin/user_connections/")) {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/v1/admin/user_connections") {
        const page = rows.slice(offset, Math.min(offset + limit, served));
        const body: Record<string, unknown> = {
          items: page,
          offset,
          limit,
          page_count: page.length,
        };
        if (options.connectionTotal) body.total_count = rows.length;
        return Response.json(body);
      }
      if (url.pathname === "/v1/admin/auth_providers") {
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
        const toolkit = url.searchParams.get("toolkit") ?? "Gmail";
        const claimed = options.toolsClaimed ?? 1;
        const toolsServed = options.toolsServed ?? claimed;
        const page: unknown[] = [];
        for (let n = offset; n < Math.min(offset + limit, toolsServed); n++) {
          page.push(toolRow(toolkit, n));
        }
        const body: Record<string, unknown> = {
          items: page,
          offset,
          limit,
          page_count: page.length,
        };
        // The short final page DROPS the field — which is what defeats a cross-check that keeps
        // the LAST page's total rather than the highest one reported.
        if (page.length === limit) body.total_count = claimed;
        return Response.json(body);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port, requests, stop: () => server.stop(true) };
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

const deletes = (e: Engine) =>
  e.requests.filter((r) => r.startsWith("/v1/admin/user_connections/"));

describe("the connection listing is read to its end, not to the SDK's", () => {
  test("revoke deletes every connection when the engine omits total_count", async () => {
    // 250 rows at a page size of 100: three pages, and NO `total_count` anywhere. The SDK's own
    // auto-pagination gives up after the first of them.
    const e = engine({ connections: 250, connectionTotal: false });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(true);
    expect(deletes(e).length).toBe(250);
  });

  test("a truncated connection listing throws rather than reading as success or as nothing", async () => {
    // The engine reports 250 and serves 100: a short second page, which ends the listing, and a
    // `total_count` that says it should not have.
    const e = engine({
      connections: 250,
      connectionTotal: true,
      connectionTruncateAt: 100,
    });
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.revoke({ account, toolkit: "Gmail" })).rejects.toThrow(
      /listed 100 of 250 connections/,
    );
    await expect(
      broker.isConnected({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/listed 100 of 250 connections/);
    await expect(
      broker.accountName({ account, toolkit: "Gmail" }),
    ).rejects.toThrow(/listed 100 of 250 connections/);
    // NOT ONE DELETE WAS SPENT on a listing that could not be trusted to be the whole of it.
    expect(deletes(e).length).toBe(0);
  });

  test("isConnected and accountName read the whole listing", async () => {
    engine({ connections: 250, connectionTotal: false });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBe(
      "person 0",
    );
  });
});

/**
 * `connection_status` IS THE ROW'S OWN ANSWER TO "IS THIS USABLE", AND THE POSITIVE READS TAKE IT.
 *
 * A row's EXISTENCE used to be the whole of the answer, so a connection the vendor was reporting as
 * no longer usable — expired, revoked at the provider, pending, failed — read as `isConnected: true`
 * with a name beside it, and the only way to find out was a tool call failing later with nothing on
 * the screen to explain it.
 *
 * The three cases below are the three halves of the design: a reported-dead row is not a connection,
 * a row the vendor said NOTHING about is still one (the field is optional on the wire, and reading
 * silence as dead would un-connect everybody against any engine that omits it), and `revoke` acts on
 * BOTH — a dead row is still a row to delete, and leaving it would be debris nobody can reach.
 */
describe("a connection the vendor reports as dead is not a live connection", () => {
  test("isConnected and accountName refuse a row whose connection_status is not live", async () => {
    engine({
      connections: 1,
      connectionTotal: false,
      connectionStatuses: ["expired"],
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(false);
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBe(null);
  });

  test("a live row beside a dead one answers for the live one", async () => {
    engine({
      connections: 2,
      connectionTotal: false,
      connectionStatuses: ["expired", "active"],
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
    // `person 0`'s row is the dead one, so its name must not be the one shown.
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBe(
      "person 1",
    );
  });

  test("a row carrying no connection_status at all still reads as connected", async () => {
    engine({
      connections: 1,
      connectionTotal: false,
      connectionStatuses: [null],
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.isConnected({ account, toolkit: "Gmail" })).toBe(true);
    expect(await broker.accountName({ account, toolkit: "Gmail" })).toBe(
      "person 0",
    );
  });

  test("revoke still deletes a dead row, and says it asked", async () => {
    const e = engine({
      connections: 2,
      connectionTotal: false,
      connectionStatuses: ["expired", "active"],
    });
    const { broker } = createArcadeClient("never-dialled");

    expect(await broker.revoke({ account, toolkit: "Gmail" })).toBe(true);
    expect(deletes(e).length).toBe(2);
  });
});

describe("the action listing's total_count cross-check survives a short final page", () => {
  test("the transport refuses a listing truncated at 250 of 300", async () => {
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 300,
      toolsServed: 250,
    });
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);

    await expect(listTools({ url: "arcade://Gmail" })).rejects.toThrow(
      /listed 250 of 300 actions for Gmail/,
    );
  });

  test("a complete listing is still accepted", async () => {
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 250,
      toolsServed: 250,
    });
    const { actions } = createArcadeClient("never-dialled");
    useArcadeClient(actions);

    expect((await listTools({ url: "arcade://Gmail" })).length).toBe(250);
  });

  test("the catalogue refuses a truncated listing too", async () => {
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 300,
      toolsServed: 250,
    });
    const { broker } = createArcadeClient("never-dialled");

    await expect(broker.listApps()).rejects.toThrow(
      /listed 250 of 300 actions, so its app catalogue is incomplete/,
    );
  });

  test("grantsFor pages past the first page", async () => {
    engine({
      connections: 0,
      connectionTotal: true,
      toolsClaimed: 250,
      toolsServed: 250,
    });
    const { broker } = createArcadeClient("never-dialled");

    expect((await broker.grantsFor({ account, toolkit: "Gmail" })).length).toBe(
      250,
    );
  });
});
