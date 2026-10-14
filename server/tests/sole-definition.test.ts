// server/tests/sole-definition.test.ts
/**
 * Guard: a decision that has been named once has EXACTLY ONE DEFINITION in this repo.
 *
 * WHY THIS EXISTS. The recurring defect across both review rounds is not a wrong line; it is a
 * right line that never reached its siblings. A fix lands at the site the reviewer pointed at, the
 * same decision stays spelled out two files away, and the next round finds it again. A round-1 DRY
 * sweep already REPORTED exactly this — `scopesOf` written four times, the brokered-provenance test
 * written in three places — and a report is not a check: nothing failed, so nothing changed, and
 * the duplicates are all still here to be read below.
 *
 * So the report is made BINDING. Each entry in {@link TRACKED} names a decision and every spelling
 * it currently answers to; the scan collects every definition of those spellings across the repo's
 * sources and compares the list against what is recorded. A symbol with no entry in
 * {@link KNOWN_DUPLICATES} must have exactly one definition. A symbol with an entry must have
 * exactly the definitions recorded there — not fewer and not more. Both directions matter:
 *
 *   - MORE fails the day somebody re-spells a tracked decision in a fifth file, which is the defect
 *     this exists to stop.
 *   - FEWER fails the day the fix cycle collapses a duplicate, which is not a regression but does
 *     mean the list is now stale. The failure says so and names the site to delete. That is how the
 *     list burns down to empty instead of quietly outliving the debt it records.
 *
 * LANDING GREEN IS DELIBERATE. Every duplicate standing today is recorded in {@link KNOWN_DUPLICATES}
 * with the finding that owns it, so this guard is green on arrival and collapsing the duplicates
 * stays with the fix cycle where a reviewer can see each merge argued for. A guard that lands red
 * gets skipped; a guard that lands green and goes red on the next re-spelling gets read.
 *
 * WHAT THE PATTERN SEES, AND WHAT IT DOES NOT. A definition is a `function`, `const`, `let`, `var`
 * or `class` binding of the name, through the shared scanner so comments are blanked (a `{@link
 * scopesOf}` in a docblock is prose, not a home) and a prettier-wrapped definition is still one
 * line. It does NOT see a name bound as an object property (`{ scopesOf: (x) => … }`), a method, or
 * a re-export alias: those spellings do not occur for the tracked names today, and widening the
 * pattern speculatively would buy false positives on every unrelated `scopesOf:` key. The names
 * list is the escape hatch instead — a decision re-spelled under a NEW name, like `isBrokered` for
 * `brokeredProvenance`, is added as an alias of the decision it duplicates, which is the only
 * reason an alias list exists at all.
 *
 * TEST FILES ARE NOT SCANNED. A `const lookup = async (hash) => …` inside a test is a fixture with
 * a short life and a local meaning, not a second home for a production decision.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logicalLines, sourceFiles } from "./support/source-scan";

const REPO = join(import.meta.dir, "../..");

/** The source trees a production decision can live in. Tests are excluded below, by file name. */
const ROOTS = [
  "app/src",
  "server/src",
  "shared",
  "worker",
  "scripts",
  "desktop/src",
  "mobile/src",
];

/**
 * A decision, every name it is currently spelled under, and — for one that is NOT in
 * {@link KNOWN_DUPLICATES} — the single file that is its home.
 *
 * The home is written down rather than inferred so the failure reads as a diff of two file lists:
 * "expected [lookup.ts], received [lookup.ts, access.ts]" names the offending file, where a bare
 * length assertion would only say "expected 1, received 2" and leave the reader to go find it.
 */
type Tracked = { decision: string; names: string[]; home?: string };

const TRACKED: Tracked[] = [
  /*
   * Is this row's provenance a broker's? Spelled as a named predicate twice and open-coded as the
   * same two-arm literal comparison a third time, under a different name, on the page that lists
   * the accounts those rows produce.
   */
  {
    decision: "brokered-provenance",
    names: ["brokeredProvenance", "isBrokered"],
  },
  /*
   * The scopes a grant/tool/config carries, read out of a shape whose field is not guaranteed.
   * Four definitions, three of them in the plugins directory.
   */
  { decision: "scopes-of", names: ["scopesOf"] },
  /*
   * The prototype-safe keyed read extracted by CL-6. Tracked from the day it lands, so the table
   * lookup never acquires a second home the way the two above did.
   */
  {
    decision: "keyed-lookup",
    names: ["keyedLookup"],
    home: "app/src/lib/lookup.ts",
  },
];

/**
 * The duplicates standing when this guard landed, each with the finding that owns collapsing it.
 *
 * Keyed by decision. The list is the debt, written down: when a finding below is fixed, its sites
 * come out of this list in the same commit, and the guard goes red if they do not.
 */
const KNOWN_DUPLICATES: Record<
  string,
  { finding: string; why: string; sites: string[] }
> = {
  "brokered-provenance": {
    finding: "round-1 DRY sweep (`brokeredProvenance` defined 2x) + G-series",
    why: "One predicate for the app and one for the server, plus the same two-arm literal open-coded as `isBrokered` on the connected-accounts page; collapsing them is a cross-package move the fix cycle owns.",
    sites: [
      "app/src/lib/plugins/provider-vocabulary.ts",
      "app/src/routes/_authed/settings/connected-accounts/index.tsx",
      "server/src/plugins/access.ts",
    ],
  },
  "scopes-of": {
    finding: "round-1 DRY sweep (`scopesOf` defined 4x)",
    why: "Four readers of the same `scopes` field with four input shapes; merging them means agreeing one shape, which is a behavioural decision and stays in the fix cycle.",
    sites: [
      "app/src/lib/plugins/grants.ts",
      "server/src/plugins/arcade-adapter.ts",
      "server/src/plugins/arcade.ts",
      "server/src/plugins/composio-adapter.ts",
    ],
  },
};

/** A binding of `name`, not a call of it and not a mention of it in prose. */
function definitionPattern(name: string): RegExp {
  return new RegExp(
    `(?:^|[^.\\w$])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?|const|let|var|class)\\s+${name}(?![\\w$])`,
  );
}

/** Not a test, not a type declaration: a file a production decision can be defined in. */
function isSource(path: string): boolean {
  return !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(path);
}

/**
 * Every source file in the repo where one of `names` is bound, one entry per binding.
 *
 * PATHS, NOT `path:line`, on purpose. A list carrying line numbers goes red when somebody rewraps
 * a comment three functions above a definition, and a guard that fails for a reason unrelated to
 * what it guards is one people learn to re-baseline without reading. A second definition in the
 * SAME file still shows up, as that path listed twice.
 */
function definitionsOf(names: string[]): string[] {
  const patterns = names.map(definitionPattern);
  const out: string[] = [];
  for (const root of ROOTS) {
    const full = join(REPO, root);
    if (!existsSync(full)) continue;
    for (const file of sourceFiles(full, [".ts", ".tsx"])) {
      if (!isSource(file)) continue;
      for (const { text } of logicalLines(readFileSync(file, "utf8"))) {
        if (patterns.some((re) => re.test(text))) {
          out.push(file.slice(REPO.length + 1));
        }
      }
    }
  }
  return out.sort();
}

for (const { decision, names, home } of TRACKED) {
  test(`"${decision}" has one definition, or exactly the duplicates on record`, () => {
    const found = definitionsOf(names);
    const known = KNOWN_DUPLICATES[decision];
    if (known) {
      // Recorded debt. Equality both ways: a new re-spelling fails, and so does a collapse that
      // did not also delete the site from the list above.
      expect(found).toEqual([...known.sites].sort());
      return;
    }
    // No recorded debt: one home, and the diff names any file that became a second one.
    expect(found).toEqual(home ? [home] : []);
  });
}

/**
 * Every spelling the name scan must catch, and every one it must not.
 *
 * The guard's own positive control plants a duplicate in a real file, which proves the walk reaches
 * it. This proves the other half: that what the walk hands the pattern is read as a definition when
 * it is one and as a call when it is not. Without this, the guard could be green because the
 * pattern matches nothing at all.
 */
test("a definition is matched, and a call or a mention is not", () => {
  const re = definitionPattern("keyedLookup");
  const definitions = [
    "function keyedLookup(map, key) {",
    "export function keyedLookup(map, key) {",
    "  const keyedLookup = (map, key) => map.get(key);",
    "export const keyedLookup = (m, k) => m.get(k);",
    "let keyedLookup;",
    "var keyedLookup = 1;",
    "class keyedLookup {}",
    "export async function keyedLookup(m, k) {",
  ];
  for (const line of definitions) expect(re.test(line)).toBe(true);
  const notDefinitions = [
    "  return keyedLookup(MARKS, key) ?? IconPlug;",
    'import { keyedLookup } from "@/lib/lookup";',
    "const mark = utils.keyedLookup(MARKS, key);",
    " * see {@link keyedLookup} for why this is a Map",
    "const keyedLookupTable = new Map();",
    "function keyedLookupTable() {}",
  ];
  for (const line of notDefinitions) expect(re.test(line)).toBe(false);
});
