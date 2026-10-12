import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE PAIRING INVARIANT, asserted over every `ConnectedAppBroker` literal in the tree.
 *
 * A broker with `authorizations === null` answers `authorizationId: null`; a broker with a
 * non-null `authorizations` answers a non-null `authorizationId` on a successful mint. It is the
 * one way spec D24's binding (the attempt's `ar_…` equals the callback's `auth_id`) rots without a
 * type error: an adapter grows a flow surface and forgets the mint id.
 *
 * A literal is found by its `grantIsLocal:` member, and its members are the lines at that same
 * indent. This reads source text because the stubs are module-local and `server/tests` is outside
 * `tsc`, so nothing else can see them all.
 */
const ROOT = join(import.meta.dir, "..");
const SELF = "broker-authorization-pairing.test.ts";
const files = [
  ...readdirSync(join(ROOT, "tests")).map((f) => join(ROOT, "tests", f)),
  ...readdirSync(join(ROOT, "src", "plugins")).map((f) =>
    join(ROOT, "src", "plugins", f),
  ),
].filter((f) => f.endsWith(".ts") && !f.endsWith(SELF));

type Literal = {
  where: string;
  authorizations: "null" | "flow";
  authorize: string;
};

const indentOf = (l: string) => /^\s*/.exec(l)![0].length;

function literalsIn(file: string): Literal[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const out: Literal[] = [];
  lines.forEach((line, at) => {
    const m = /^(\s*)grantIsLocal:\s*(true|false),?\s*$/.exec(line);
    if (!m) return;
    const indent = m[1]!.length;
    let from = at;
    while (
      from > 0 &&
      (lines[from - 1]!.trim() === "" || indentOf(lines[from - 1]!) >= indent)
    )
      from--;
    let to = at;
    while (
      to < lines.length - 1 &&
      (lines[to + 1]!.trim() === "" || indentOf(lines[to + 1]!) >= indent)
    )
      to++;
    const block = lines.slice(from, to + 1);
    const members = block
      .map((l, i) => ({ l, i }))
      .filter(
        ({ l }) =>
          indentOf(l) === indent && /^\s*(async\s+)?\w+\??\s*[(:]/.test(l),
      );
    const named = (name: string) =>
      members.findIndex(({ l }) =>
        new RegExp(`^\\s*(async\\s+)?${name}\\s*[(:]`).test(l),
      );
    const a = named("authorizations");
    const z = named("authorize");
    if (z < 0) {
      throw new Error(
        `${file}:${at + 1}: a broker literal with no authorize member`,
      );
    }
    // The one literal that omits `authorizations` is composio-grants-for's deliberate
    // does-not-compile witness, which is then spread with `authorizations: null` — so an omission
    // is read as the null it is completed with there.
    const aLine = a < 0 ? "authorizations: null" : block[members[a]!.i]!;
    const end = z + 1 < members.length ? members[z + 1]!.i : block.length;
    out.push({
      where: `${file.slice(ROOT.length + 1)}:${from + members[z]!.i + 1}`,
      authorizations: /authorizations:\s*null\b/.test(aLine) ? "null" : "flow",
      authorize: block.slice(members[z]!.i, end).join("\n"),
    });
  });
  return out;
}

const literals = files.flatMap(literalsIn);

describe("authorizations and authorizationId are declared as a pair", () => {
  test("the scan finds the production adapters and the test stubs", () => {
    const places = literals.map((l) => l.where);
    expect(
      places.some((p) => p.startsWith("src/plugins/arcade-adapter.ts")),
    ).toBe(true);
    expect(
      places.some((p) => p.startsWith("src/plugins/composio-adapter.ts")),
    ).toBe(true);
    expect(literals.length).toBeGreaterThanOrEqual(14);
  });

  for (const literal of literals) {
    test(literal.where, () => {
      // A stub that never mints (it throws, or is `unasked`) answers no url, so the pair is moot.
      const head = literal.authorize.split("\n").slice(0, 3).join("\n");
      const mints =
        /redirectUrl/.test(literal.authorize) &&
        !/\bthrow\b|unasked\(/.test(head);
      if (!mints) return;
      // The seam type's own `authorizationId: string | null` annotation is not an answer.
      const code = literal.authorize.replaceAll(
        "authorizationId: string | null",
        "",
      );
      if (literal.authorizations === "null") {
        expect(code).toMatch(/authorizationId:\s*null/);
        expect(code).not.toMatch(/authorizationId:(?!\s*null)/);
      } else {
        expect(code).toMatch(/authorizationId:/);
        expect(code).not.toMatch(/authorizationId:\s*null/);
      }
    });
  }
});
