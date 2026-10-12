import { expect, test } from "bun:test";
import {
  brokeredConnectionDescription,
  brokeredDisconnectNote,
  brokeredProvenance,
  brokeredReach,
  directoryRouteDecision,
  moreAppsRow,
  moreAppsSectionDescription,
  providerVocabulary,
} from "@/lib/plugins/provider-vocabulary";
import type { PluginsPage } from "@/lib/plugins/queries";

/**
 * The admin Plugins screens carry the ACTIVE provider's vocabulary only (spec D11). Everything here
 * is a pure function, so nothing renders.
 */

const page = (provider?: "composio" | "arcade") =>
  ({ provider }) as PluginsPage;

test("an Arcade deployment names Arcade and carries nothing Composio-specific", () => {
  const everything = JSON.stringify([
    providerVocabulary("arcade"),
    moreAppsRow("arcade", true),
    moreAppsRow("arcade", false),
    moreAppsSectionDescription("arcade"),
    brokeredConnectionDescription("arcade"),
    brokeredReach("arcade"),
    brokeredDisconnectNote("arcade"),
  ]);
  expect(everything).not.toMatch(/composio/i);
  expect(providerVocabulary("arcade").envVar).toBe("ARCADE_API_KEY");
  expect(providerVocabulary("arcade").directoryPath).toBe(
    "/admin/plugins/arcade",
  );
  expect(brokeredProvenance("arcade")).toBe(true);
});

test("a Composio deployment keeps today's exact wording", () => {
  expect(providerVocabulary("composio")).toEqual({
    name: "Composio",
    directoryLabel: "Browse Composio",
    envVar: "COMPOSIO_API_KEY",
    directoryPath: "/admin/plugins/composio",
  });
  expect(moreAppsSectionDescription("composio")).toBe(
    "A directory this deployment has not reviewed, reached through Composio.",
  );
  expect(moreAppsRow("composio", true)).toEqual({
    title: "Browse Composio",
    description:
      "A few hundred apps, reached as whoever is asking. Each person connects their own account.",
    linked: true,
  });
  expect(moreAppsRow("composio", false)).toEqual({
    title: "Composio",
    description:
      "Add your Composio key to enable a catalogue of tools. Set COMPOSIO_API_KEY on this deployment.",
    linked: false,
  });
  expect(brokeredConnectionDescription("composio")).toBe(
    "Reached through Composio, which holds each person's own account.",
  );
  expect(brokeredReach("composio")).toEqual({
    description:
      "This app is reached through Composio, which holds the account. This deployment sends one key and the name of whoever is asking, so each person connects their own and a Bot sees only what that person can see. There is no token to paste.",
    badge: "Through Composio",
  });
  expect(brokeredDisconnectNote("composio")).toBe(
    "Disconnecting ends the account at Composio, not just here.",
  );
});

test("the vocabulary follows the provider rather than being hard-coded", () => {
  expect(moreAppsRow("arcade", false).title).toBe("Arcade");
  expect(moreAppsRow("arcade", false).description).toContain("ARCADE_API_KEY");
  expect(brokeredReach("arcade").badge).toBe("Through Arcade");
  expect(brokeredDisconnectNote("arcade")).toContain("Arcade");
  expect(moreAppsRow("arcade", true).linked).toBe(false);
});

test("brokered-ness is read off the row and needs no provider", () => {
  expect(brokeredProvenance("composio")).toBe(true);
  expect(brokeredProvenance("arcade")).toBe(true);
  expect(brokeredProvenance("custom")).toBe(false);
  expect(brokeredProvenance("first-party")).toBe(false);
});

test("the Composio directory route does not answer on an Arcade deployment", () => {
  expect(directoryRouteDecision("composio", page("arcade"))).toBe("redirect");
  expect(directoryRouteDecision("arcade", page("composio"))).toBe("redirect");
  expect(directoryRouteDecision("composio", page("composio"))).toBe("render");
  // An older server that did not say is Composio.
  expect(directoryRouteDecision("composio", page(undefined))).toBe("render");
  // Not answering before the page says which provider this is.
  expect(directoryRouteDecision("composio", undefined)).toBe("pending");
});
