/**
 * The test process's egress, closed at the transport rather than asked for politely file by file.
 *
 * A test that dials a vendor stops being a fact about this repository. It passes or fails on the
 * vendor's uptime, on DNS and on whatever the network did that minute, so a red says nothing and a
 * green says less than it looks like; it is slow and flaky in a suite this size; it carries
 * whatever the test handed it — an API key, a user id, a return address — to a third party; and it
 * is a real request against a real service, made from CI, on every run.
 *
 * EVERY TEST FILE ALREADY MEANT TO STUB, AND STUBBING PER FILE IS WHAT FAILED. `server/tests/
 * composio-broker-seam.test.ts` assigned `globalThis.fetch` around the call it was about and still
 * reached `https://backend.composio.dev/api/v3.1/auth_configs` on every run, because the vendor
 * client had been constructed one line EARLIER and `@composio/client` binds its transport once, at
 * construction (`this.fetch = options.fetch ?? Shims.getDefaultFetch()`, `client.mjs:122`). A stub
 * installed after that point is a stub the SDK never sees. That failure mode is invisible in review
 * — the file reads as if it stubs — which is why the floor is here, in a preload that runs before
 * any test file is imported and therefore before any vendor client can capture a transport.
 *
 * WHAT IS REFUSED: an HTTP request to anything that is not loopback. Loopback is allowed because
 * the suite's own servers are loopback — `Bun.serve`, the route tests' ephemeral ports — and a test
 * talking to a server it started is not talking to anyone.
 *
 * WHAT IS NOT GUARDED, AND WHY: raw `node:net`/`node:tls` sockets, which are how the Postgres
 * driver reaches the test database. That host is deployment configuration (`TEST_DATABASE_URL`) and
 * is not necessarily loopback, so a guard there would refuse the database rather than a vendor. No
 * vendor SDK in this repository speaks a non-HTTP protocol: both brokered vendors, every model
 * provider and every OAuth exchange go through `fetch`, and `node:http`/`node:https` are guarded
 * alongside it so that a dependency which reaches for the older transport is caught too.
 *
 * HOW A SUITE THAT IS MEANT TO DIAL OPTS OUT: any `OPENBOT_LIVE_*` variable with a non-empty value.
 * The three live suites already set one — `OPENBOT_LIVE_COMPOSIO`, `OPENBOT_LIVE_ARCADE` and
 * `OPENBOT_LIVE_SCREEN` are set by their `test:live-*` scripts in `package.json`, which also refuse
 * to run without a key, so a live suite remains deliberate and credentialed and stays skipped
 * otherwise.
 */

import http from "node:http";
import https from "node:https";

const liveRun = Object.entries(process.env).some(
  ([name, value]) => name.startsWith("OPENBOT_LIVE_") && (value ?? "").trim(),
);

/** Loopback, in every spelling a URL or a Node request option can arrive in. */
function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0.0.0.0" ||
    bare === "::" ||
    bare === "" ||
    bare.endsWith(".localhost") ||
    /^127\./.test(bare)
  );
}

/**
 * Every target this guard refused, in order, on the global so a test can read it.
 *
 * A refusal does not always reach the caller as itself: `@composio/client` retries a rejected
 * transport and then reports "Connection error.", which is the same sentence a real outage would
 * produce. So the fact that the guard — rather than the network — stopped a call is recorded here
 * at the point of refusal, where it is unambiguous. `server/tests/test-network-guard.test.ts` reads
 * it; nothing in `server/src` may.
 */
declare global {
  var openbotTestNetworkRefusals: string[] | undefined;
}

globalThis.openbotTestNetworkRefusals = [];

function refuse(target: string): Error {
  globalThis.openbotTestNetworkRefusals?.push(target);
  return new Error(
    `A test tried to reach ${target}. Tests do not use the network: stub the transport this call ` +
      "goes through (and stub it BEFORE constructing any client, which binds `fetch` once), or, " +
      "for a deliberate vendor suite, set an OPENBOT_LIVE_* variable as `bun run test:live-*` " +
      "does. Guard: server/scripts/test-network-guard.ts.",
  );
}

if (!liveRun) {
  const passThrough = globalThis.fetch;

  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string } | null)?.url ?? String(input));
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      // A relative or unparseable target reaches no host; the runtime's own error is the right one.
    }
    if (url && (url.protocol === "http:" || url.protocol === "https:")) {
      if (!isLoopback(url.hostname)) {
        return Promise.reject(refuse(url.origin + url.pathname));
      }
    }
    return passThrough(input as RequestInfo | URL, init);
  }) as typeof globalThis.fetch;

  /*
   * `request` is forwarded through an `unknown[]` signature rather than one of its four overloads:
   * nothing here reads an argument it did not already read off the first one, and restating the
   * overloads would be a declaration to maintain against Node's.
   */
  type NodeRequest = (...args: unknown[]) => unknown;
  for (const module of [http, https] as const) {
    const passThroughRequest = module.request as unknown as NodeRequest;
    (module as unknown as { request: NodeRequest }).request = (
      ...args: unknown[]
    ) => {
      const first = args[0];
      const target =
        typeof first === "string"
          ? new URL(first).hostname
          : first instanceof URL
            ? first.hostname
            : ((first as { hostname?: string; host?: string } | null)
                ?.hostname ??
              (first as { host?: string } | null)?.host ??
              "");
      if (!isLoopback(String(target).replace(/:\d+$/, ""))) {
        throw refuse(String(target));
      }
      return passThroughRequest(...args);
    };
  }
}
