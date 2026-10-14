import { describe, expect, test } from "bun:test";
import dgram from "node:dgram";
import http from "node:http";
import http2 from "node:http2";
import https, { get as namedHttpsGet } from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createComposioClient } from "../src/plugins/composio-adapter";

/**
 * The guard that makes a live vendor call impossible, asserted rather than assumed — ONE ENTRY
 * POINT AT A TIME.
 *
 * `server/scripts/test-network-guard.ts` runs from the preload, before any test file is imported.
 * Its first version patched `globalThis.fetch` and `http(s).request` only, and this file asserted
 * it through `fetch` only, so it stayed green while `https.get` returned 200 from example.com and
 * `Bun.fetch` was not guarded at all. A guard is exactly as wide as the entry points its test
 * plants a call through, so every entry point a test file could open a connection with is planted
 * below, separately, and each one must end in a refusal the GUARD recorded during THAT call.
 *
 * Why the record rather than the error: a refusal does not always reach the caller as itself (the
 * Composio SDK retries and says "Connection error.", and a native `Bun.fetch` sees the refusing
 * proxy's 403), and an error alone cannot tell a guarded call from a dialled one that failed. Why
 * only the entries recorded during the call: the record is process-wide, so a check against the
 * whole of it would be satisfied by whichever earlier test happened to be refused.
 *
 * example.com is the far side throughout: the assertion is that NOTHING is dialled, so the address
 * should be one no product code would ever have reason to reach.
 */

const FAR = "example.com";

/** Runs one planted call and returns what it came to and what the guard recorded while it ran. */
async function plant(
  call: () => unknown,
): Promise<{ outcome: string; refused: string[] }> {
  const record = globalThis.openbotTestNetworkRefusals;
  if (!record) throw new Error("the network guard did not install its record");
  const before = record.length;
  let outcome: string;
  try {
    const value = await call();
    outcome =
      value instanceof Response
        ? `response ${value.status} ${value.headers.get("x-openbot-test-network-guard") ?? "unguarded"}`
        : "returned";
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error);
  }
  return { outcome, refused: record.slice(before) };
}

const refusedCall = "Tests do not use the network";
const refusedByProxy = "response 403 refused";

/** Each entry point, the call it plants, the outcome the caller sees and the target recorded. */
const entryPoints: Array<[string, () => unknown, string, string]> = [
  [
    "globalThis.fetch",
    () => fetch(`https://${FAR}/x`),
    refusedCall,
    `https://${FAR}/x`,
  ],
  [
    "Bun.fetch",
    () => Bun.fetch(`https://${FAR}/x`),
    refusedByProxy,
    `https://${FAR}`,
  ],
  [
    "Bun.fetch over http",
    () => Bun.fetch(`http://${FAR}/x`),
    refusedByProxy,
    `http://${FAR}/x`,
  ],
  [
    "undici fetch",
    () =>
      (require("undici") as { fetch: typeof fetch }).fetch(`https://${FAR}/x`),
    refusedByProxy,
    `https://${FAR}`,
  ],
  [
    "undici request",
    async () => {
      const { statusCode, headers } = await (
        require("undici") as {
          request: (url: string) => Promise<{
            statusCode: number;
            headers: Record<string, string>;
          }>;
        }
      ).request(`https://${FAR}/x`);
      return new Response(null, { status: statusCode, headers });
    },
    refusedByProxy,
    `https://${FAR}`,
  ],
  ["http.request", () => http.request(`http://${FAR}/x`), refusedCall, FAR],
  [
    "https.request",
    () => https.request({ hostname: FAR, path: "/x" }),
    refusedCall,
    FAR,
  ],
  ["http.get", () => http.get(`http://${FAR}/x`), refusedCall, FAR],
  ["https.get", () => https.get(`https://${FAR}/x`), refusedCall, FAR],
  [
    "named import of https.get",
    () => namedHttpsGet(`https://${FAR}/x`),
    refusedCall,
    FAR,
  ],
  [
    "http.ClientRequest",
    () => new http.ClientRequest(`http://${FAR}/x`),
    refusedCall,
    FAR,
  ],
  ["net.connect", () => net.connect(80, FAR), refusedCall, `socket ${FAR}`],
  [
    "net.Socket#connect",
    () => new net.Socket().connect({ host: FAR, port: 80 }),
    refusedCall,
    `socket ${FAR}`,
  ],
  [
    "tls.connect",
    () => tls.connect(443, FAR, { servername: FAR }),
    refusedCall,
    `socket ${FAR}`,
  ],
  [
    "Bun.connect",
    () => Bun.connect({ hostname: FAR, port: 80, socket: { data() {} } }),
    refusedCall,
    `socket ${FAR}`,
  ],
  [
    "http2.connect",
    () => http2.connect(`https://${FAR}`),
    refusedCall,
    `http2 ${FAR}`,
  ],
  [
    "WebSocket",
    () => new WebSocket(`wss://${FAR}/x`),
    refusedCall,
    `wss://${FAR}/x`,
  ],
  [
    "ws WebSocket",
    () =>
      new (require("ws") as { WebSocket: typeof WebSocket }).WebSocket(
        `wss://${FAR}/x`,
      ),
    refusedCall,
    `wss://${FAR}/x`,
  ],
  [
    "dgram send",
    () => {
      const socket = dgram.createSocket("udp4");
      try {
        socket.send("x", 9, FAR);
      } finally {
        socket.close();
      }
    },
    refusedCall,
    `udp ${FAR}`,
  ],
  [
    "Bun.udpSocket send",
    async () => {
      const socket = await Bun.udpSocket({});
      try {
        socket.send("x", 9, FAR);
      } finally {
        socket.close();
      }
    },
    refusedCall,
    `udp ${FAR}`,
  ],
];

describe("the test network guard refuses a host that is not loopback, through", () => {
  test.each(entryPoints)("%s", async (_name, call, seen, target) => {
    const { outcome, refused } = await plant(call);

    expect(outcome).toContain(seen);
    expect(refused).toEqual([target]);
  });
});

describe("the test network guard lets the suite reach what the suite owns", () => {
  test("a loopback HTTP server, through fetch, Bun.fetch and node:http", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("local") });
    try {
      const { outcome, refused } = await plant(async () => {
        const answers = [
          await (await fetch(`http://127.0.0.1:${server.port}/`)).text(),
          await (await Bun.fetch(`http://localhost:${server.port}/`)).text(),
          await new Promise<string>((resolve, reject) => {
            http
              .get(`http://127.0.0.1:${server.port}/`, (response) => {
                let body = "";
                response.on("data", (chunk) => (body += chunk));
                response.on("end", () => resolve(body));
              })
              .on("error", reject);
          }),
        ];
        return answers.join(",");
      });

      expect(outcome).toBe("returned");
      expect(refused).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("a loopback socket, through net.connect", async () => {
    const listener = net.createServer((socket) => socket.end("local"));
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as net.AddressInfo;
    try {
      const { outcome, refused } = await plant(
        () =>
          new Promise<string>((resolve, reject) => {
            const socket = net.connect(port, "127.0.0.1");
            let body = "";
            socket.on("data", (chunk) => (body += chunk));
            socket.on("end", () => resolve(body));
            socket.on("error", reject);
          }),
      );

      expect(outcome).toBe("returned");
      expect(refused).toEqual([]);
    } finally {
      listener.close();
    }
  });

  /**
   * The database is the one far host a raw socket may reach, because it is deployment
   * configuration rather than a vendor. `.invalid` never resolves, so the connection fails in DNS
   * — and the point is that it got as far as DNS instead of being refused.
   */
  test("the configured database host, through a raw socket", async () => {
    const configured = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = "postgres://u:p@db.openbot.invalid:5432/x";
    try {
      const { outcome, refused } = await plant(
        () =>
          new Promise<void>((_resolve, reject) => {
            net.connect(5432, "db.openbot.invalid").on("error", reject);
          }),
      );

      expect(outcome).not.toContain(refusedCall);
      expect(refused).toEqual([]);
    } finally {
      if (configured === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = configured;
    }
  });
});

/**
 * The case the guard was written for, in the shape that defeated the per-file stub: the vendor
 * client is constructed with no stub in sight, and its own bound transport is the guard.
 */
test("the test network guard is in force for a vendor SDK that binds its own transport", async () => {
  const { broker } = createComposioClient("never-dialled");

  const { outcome, refused } = await plant(() =>
    broker.authorize({
      account: { holder: "person", userId: "u", vendorUserId: "u" },
      toolkit: "linear",
      returnUrl: "https://openbot.test/settings/connected-accounts/x",
    }),
  );

  expect(outcome).not.toBe("returned");
  /*
   * ASSERTED ON THE GUARD'S OWN RECORD RATHER THAN THE MESSAGE, because the SDK retries the
   * rejected transport and reports "Connection error." — the same sentence a real outage gives,
   * so a test that read it could not tell a guarded call from a dialled one that failed.
   */
  expect(refused.length).toBeGreaterThan(0);
  expect(
    refused.every((target) => target.includes("backend.composio.dev")),
  ).toBe(true);
});
