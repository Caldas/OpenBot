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
 *   1. `index.tsx` and `$key.tsx` contain no capitalised "Composio" NOR the
 *      all-caps "COMPOSIO" (string
 *      literal, JSX text or test id).
 *   2. each vocabulary function appears in the file that should call it.
 *
 * `composio.tsx` is exempt from (1): that route is Composio-gated by
 * construction (directoryRouteDecision), so its literals are legitimate. It is
 * still held to (2).
 *
 * If this goes red, route the string through provider-vocabulary.ts; do not
 * loosen the guard. The scanned-count assertion stops it passing vacuously.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

const VOCAB_CALLERS: Record<string, string[]> = {
  "index.tsx": ["moreAppsRow", "moreAppsSectionDescription"],
  "$key.tsx": [
    "brokeredConnectionDescription",
    "brokeredReach",
    "brokeredDisconnectNote",
    "brokeredProvenance",
  ],
  "composio.tsx": ["directoryRouteDecision"],
};

const NO_VENDOR_LITERAL = ["index.tsx", "$key.tsx"];

test("the provider-neutral plugins pages carry no Composio literal", () => {
  expect(NO_VENDOR_LITERAL.length).toBe(2);
  const offenders: string[] = [];
  for (const name of NO_VENDOR_LITERAL) {
    const text = load(name);
    expect(text.length).toBeGreaterThan(1000);
    text.split("\n").forEach((line, i) => {
      // Capitalised AND all-caps. `COMPOSIO_API_KEY` is a user-visible string 1.8 moved
      // into the vocabulary (`envVar`), rendered as "Set COMPOSIO_API_KEY on this
      // deployment." — it must read ARCADE_API_KEY on an Arcade deployment, and an
      // env-var name is exactly the string an editor inlines as a constant. NOT
      // case-insensitive: `composioConfigured` and the `/admin/plugins/composio` route
      // path are legitimate and must stay legal.
      if (/Composio|COMPOSIO/.test(line))
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("each plugins page calls the vocabulary functions it should", () => {
  expect(Object.keys(VOCAB_CALLERS).length).toBe(3);
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
