// server/tests/brokered-provenance.test.ts
/**
 * Guard: no plugin module outside the three VOCABULARY modules may spell a brokered vendor's name —
 * in a provenance or provider comparison, or in a url scheme it builds.
 *
 * `access.ts`, `composio.ts` and `arcade.ts` are the exempt files. `access.ts` is where the shared
 * vocabulary lives — {@link BrokerProvider}, {@link brokeredProvenance}, `TOOLKIT_OF` and
 * `BROKERED_PROFILE`, which is why the scheme literals are there and not in `store.ts`. The other
 * two are each one broker's own module, and a module whose whole job is to speak one vendor's
 * protocol has to be able to spell that vendor's scheme and define that vendor's parser. Neither
 * trips the provenance patterns today, and neither is exempt from anything it does not need:
 * widening the list is what makes the scheme pattern absolute everywhere else, instead of a pattern
 * with a per-line escape hatch — and an escape hatch in a guard is the thing that gets used the
 * second time without the argument being made again.
 *
 * COMMENT LINES ARE SKIPPED, DELIBERATELY AND NARROWLY. A line whose trimmed start is `*`, `//` or
 * `/*` is not scanned. `store.ts` alone carries about a dozen `composio://` mentions inside
 * docblocks — "a row called `gmail` at `composio://slack`" and the like — which are explanation of
 * why a rule exists, not an instance of breaking it. A SCHEME NAMED IN PROSE IS DOCUMENTATION; A
 * SCHEME NAMED IN AN EXPRESSION IS A DECISION. The skip is on the line's syntactic position and
 * nothing else, so it cannot grow: the alternative — loosening the pattern until the docblocks stop
 * matching — would also stop it matching the thing it is for, which is a string carrying a scheme.
 *
 * The offenders are collected into a list and compared against `[]` rather than asserted one file at
 * a time, so a new site has to be argued for here rather than quietly allowed.
 *
 * THE OTHER HALF OF THIS GUARD IS NOT ARMED YET, and this is the record of why. A direct call to a
 * vendor module's own parser — `toolkitOf(url)` rather than `toolkitOfFor(provider, url)` — is the
 * same mistake as a spelled scheme, and the pattern for it is `/\btoolkitOf\s*\(/`. Run today it
 * names eight lines:
 *
 *   `routes.ts` 617, 815, 1143, 1886 — genuine. That module imports `toolkitOf` from `./composio`
 *   and parses every brokered url with Composio's parser, so on any other broker each of these
 *   answers null and the route refuses an app that is perfectly well connected. It cannot be fixed
 *   here: `routes.ts` holds no provider at all (`grep -n 'provider' server/src/plugins/routes.ts`
 *   is empty), so routing these through `toolkitOfFor` means wiring the active broker into the
 *   routes layer, which is a change of its own.
 *
 *   `shared-use-store.ts` 154, 427, 484, 492 — false positives. Those call a LOCAL closure that
 *   happens to be named `toolkitOf` and whose body is `toolkitOfFor(provider, url)`: the dispatch
 *   itself, read by the pattern as the thing it dispatches to.
 *
 * Arming it now would mean exempting a fourth and fifth module, which is exactly the hatch the
 * paragraph above refuses. So it waits for the routes layer to learn its provider and for that
 * closure to be renamed, and this comment is what stops the pattern being quietly dropped instead.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGINS_DIR = join(import.meta.dir, "../src/plugins");

/** The modules allowed to speak a broker's vocabulary. Every other plugin module asks them. */
const VOCABULARY = new Set(["access.ts", "composio.ts", "arcade.ts"]);

const PATTERNS: RegExp[] = [
  /provenance\s*[!=]==\s*"(composio|arcade)"/,
  /brokeredConnections\.provider\s*,\s*"(composio|arcade)"/,
  /provider:\s*"(composio|arcade)"/,
  // `eq(mcpServers.provenance, "composio")`: the drizzle spelling of the same mistake as the
  // `provenance === "composio"` pattern above. A guard catching one spelling of a mistake and not
  // the other is worse than none, because it is read as coverage.
  /(mcpServers|\w+)\.provenance\s*,\s*"(composio|arcade)"/,
  // A scheme spelled into a string — the construction half. `composio://${toolkit}` in `store.ts`
  // is what dropped every Arcade connection off the settings page and what sent an Arcade
  // deployment's probe to Composio; the scheme comes out of `BROKERED_PROFILE` now.
  /["'`](composio|arcade):\/\//,
];

/** A line of prose rather than a line of code. See the docblock: the skip is narrow on purpose. */
function isComment(line: string): boolean {
  const start = line.trimStart();
  return (
    start.startsWith("*") || start.startsWith("//") || start.startsWith("/*")
  );
}

test("no plugin module hard-codes a brokered vendor name outside the vocabulary modules", () => {
  const offenders: string[] = [];
  const files = readdirSync(PLUGINS_DIR)
    .filter((f) => f.endsWith(".ts") && !VOCABULARY.has(f))
    .sort();
  for (const file of files) {
    const lines = readFileSync(join(PLUGINS_DIR, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      if (PATTERNS.some((re) => re.test(line))) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});

/**
 * And the comment skip does not also skip code, which is the one way this guard could go quietly
 * useless. Each line below is an offender the scan must still name, including the ones that carry a
 * comment — a trailing `//` does not make a line prose, and only a line that STARTS as prose is
 * skipped.
 */
test("the comment skip takes prose and leaves every expression", () => {
  const code = [
    // Interpolation is spelled by concatenation here only so the linter does not read a template
    // placeholder inside a plain string as a mistake; what the pattern sees is the same line.
    `const url = \`composio://$\{toolkit}\`;`,
    `const url = \`arcade://$\{toolkit}\`; // the scheme`,
    '    return { url: "composio://gmail" };',
    '\tif (row.provenance === "arcade") return null;',
    'const u = "composio://" + toolkit; /* trailing block */',
  ];
  const prose = [
    " * a row called `gmail` at `composio://slack` would decide a Slack confirm",
    "// `arcade://Gmail` and `arcade://gmail` are distinct apps.",
    "/* `composio://` is the scheme the rows are minted at. */",
    '  * `provenance === "composio"` was the comparison this replaced.',
  ];
  for (const line of code) {
    expect(isComment(line)).toBe(false);
    expect(PATTERNS.some((re) => re.test(line))).toBe(true);
  }
  for (const line of prose) {
    // Prose that WOULD match: the skip is what spares it, not a gap in the patterns.
    expect(PATTERNS.some((re) => re.test(line))).toBe(true);
    expect(isComment(line)).toBe(true);
  }
});
