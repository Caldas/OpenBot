import { describe, expect, test } from "bun:test";
import { createComposioClient } from "../src/plugins/composio-adapter";

/**
 * The guard that makes a live vendor call impossible, asserted rather than assumed.
 *
 * `server/scripts/test-network-guard.ts` runs from the preload, before any test file is imported,
 * and refuses every HTTP request to a host that is not loopback. It exists because stubbing per
 * file does not hold: a vendor client binds its transport in its constructor, so a stub installed
 * one line later governs nothing, and the file still reads as if it stubs. That is exactly how
 * `composio-broker-seam.test.ts` reached `backend.composio.dev` on every run.
 *
 * Three facts are worth pinning. The guard refuses the far side; it does NOT refuse the suite's own
 * loopback servers, which half the route tests are; and it is in force for a vendor SDK, which is
 * the case it was written for and the one a per-file stub kept missing.
 */
describe("the test network guard", () => {
  test("refuses a request to a host that is not loopback", async () => {
    // example.com rather than a vendor: the assertion is that NOTHING is dialled, so the address
    // this case names should be one no product code would ever have reason to reach.
    const attempt = await fetch("https://example.com/anything").then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );

    expect(attempt).toContain("Tests do not use the network");
    expect(attempt).toContain("example.com");
  });

  test("lets the suite talk to a server the suite started", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("local"),
    });
    try {
      const answer = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await answer.text()).toBe("local");
      expect(
        await (await fetch(`http://localhost:${server.port}/`)).text(),
      ).toBe("local");
    } finally {
      await server.stop(true);
    }
  });

  /**
   * The case the guard was written for, in the shape that defeated the per-file stub: the vendor
   * client is constructed with no stub in sight, and its own bound transport is the guard.
   */
  test("is in force for a vendor SDK that binds its own transport", async () => {
    const { broker } = createComposioClient("never-dialled");

    const attempt = await broker
      .authorize({
        account: { holder: "person", userId: "u", vendorUserId: "u" },
        toolkit: "linear",
        returnUrl: "https://openbot.test/settings/connected-accounts/x",
      })
      .then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : ""),
      );

    expect(attempt).not.toBe("resolved");
    /*
     * ASSERTED ON THE GUARD'S OWN RECORD RATHER THAN THE MESSAGE, because the SDK retries the
     * rejected transport and reports "Connection error." — the same sentence a real outage gives,
     * so a test that read it could not tell a guarded call from a dialled one that failed.
     */
    expect(globalThis.openbotTestNetworkRefusals?.join(" ")).toContain(
      "backend.composio.dev",
    );
  });
});
