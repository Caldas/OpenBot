// app/tests/admin-plugins-vocabulary-wiring.test.ts
/**
 * Guard: the admin plugins pages CALL the provider vocabulary; they do not
 * re-hardcode a vendor name.
 *
 * WHY: arcade-admin-plugins.test.tsx pins every string the vocabulary
 * functions return, but nothing pinned that `index.tsx` and `$key.tsx` actually
 * call them. A guard on return values without one on call sites reads as
 * coverage while protecting nothing: a later edit can paste "Composio" straight
 * back into the JSX, every vocabulary test stays green, and an Arcade
 * deployment shows a Composio-named screen (spec D11: screens show the ACTIVE
 * provider only; this PR changes no Composio behaviour). It is the same
 * argument the server-side vendor-name guard makes about catching one spelling
 * of a mistake and not the other.
 *
 * Reads the route sources as TEXT (like arcade-no-browser-calls.test.ts) and
 * imports nothing from them. Comments are stripped first, so docblocks may
 * still explain the vendor. Then:
 *   1. NO route file under the plugins directory contains a capitalised
 *      "Composio" NOR the all-caps "COMPOSIO" (string literal, JSX text or test
 *      id). `composio.tsx` USED to be exempt, on the argument that the route is
 *      Composio-gated by construction. The screen it held has moved to
 *      `components/plugins/broker-directory.tsx`, so the file holds no vendor
 *      literal and the exemption has no reason left — and an exemption kept
 *      after its reason has gone is an escape hatch waiting to be used a second
 *      time.
 *   2. NO route file contains a hard-coded `/admin/plugins/composio` or
 *      `/admin/plugins/arcade` navigation target. THIS IS THE LOWERCASE
 *      SPELLING RULE (1) CANNOT SEE, and it is the one that stranded the
 *      enablement notes: `index.tsx` linked every deployment, Arcade ones
 *      included, at the Composio directory, which redirected them straight
 *      back — so two measured warnings rendered on no deployment that exists.
 *      The path belongs in `providerVocabulary().directoryPath`, whose literal
 *      union is checked against the generated route tree. Each file's own
 *      `createFileRoute("/_authed/admin/plugins/…")` id is not a navigation
 *      target and is excluded by the `_authed` prefix.
 *   3. each vocabulary function appears in the file that should call it.
 *
 * If this goes red, route the string through provider-vocabulary.ts; do not
 * loosen the guard. The scanned-count and file-length assertions stop it
 * passing vacuously.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../src/routes/_authed/admin/plugins");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1");
}

function load(name: string): string {
  return stripComments(readFileSync(join(DIR, name), "utf8"));
}

/** Every route file in the directory, so a new one is scanned the day it lands. */
const ALL_ROUTES = readdirSync(DIR)
  .filter((name) => name.endsWith(".tsx"))
  .sort();

const VOCAB_CALLERS: Record<string, string[]> = {
  "index.tsx": [
    "moreAppsRow",
    "moreAppsSectionDescription",
    "providerVocabulary",
  ],
  "$key.tsx": [
    "brokeredConnectionDescription",
    "brokeredReach",
    "brokeredDisconnectNote",
    "brokeredProvenance",
  ],
  "composio.tsx": ["directoryRouteDecision"],
  "arcade.tsx": ["directoryRouteDecision"],
};

const NO_VENDOR_LITERAL = ["index.tsx", "$key.tsx", "composio.tsx"];

test("the plugins routes carry no Composio literal", () => {
  // composio.tsx is no longer exempt; $key_.bots and $key_.tools are vendor-blind already.
  expect(NO_VENDOR_LITERAL.length).toBe(3);
  const offenders: string[] = [];
  for (const name of NO_VENDOR_LITERAL) {
    const text = load(name);
    expect(text.length).toBeGreaterThan(500);
    text.split("\n").forEach((line, i) => {
      // Capitalised AND all-caps. `COMPOSIO_API_KEY` is a user-visible string 1.8 moved
      // into the vocabulary (`envVar`), rendered as "Set COMPOSIO_API_KEY on this
      // deployment." — it must read ARCADE_API_KEY on an Arcade deployment, and an
      // env-var name is exactly the string an editor inlines as a constant. NOT
      // case-insensitive: `composioConfigured` and the `/_authed/admin/plugins/composio`
      // route id are legitimate and must stay legal.
      if (/Composio|COMPOSIO/.test(line))
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("no plugins route hard-codes a directory path", () => {
  expect(ALL_ROUTES.length).toBeGreaterThanOrEqual(6);
  expect(ALL_ROUTES).toContain("arcade.tsx");
  expect(ALL_ROUTES).toContain("composio.tsx");
  const offenders: string[] = [];
  for (const name of ALL_ROUTES) {
    const text = load(name);
    expect(text.length).toBeGreaterThan(500);
    text.split("\n").forEach((line, i) => {
      // The route's own file id carries `_authed` and is not somewhere anybody navigates.
      if (/(?<!_authed)\/admin\/plugins\/(composio|arcade)/.test(line))
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("each plugins page calls the vocabulary functions it should", () => {
  expect(Object.keys(VOCAB_CALLERS).length).toBe(4);
  const missing: string[] = [];
  for (const [name, fns] of Object.entries(VOCAB_CALLERS)) {
    const text = load(name);
    for (const fn of fns) {
      if (!new RegExp(`\\b${fn}\\(`).test(text))
        missing.push(`${name} -> ${fn}`);
    }
  }
  expect(missing).toEqual([]);
});
