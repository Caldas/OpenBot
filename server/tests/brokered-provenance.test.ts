// server/tests/brokered-provenance.test.ts
/**
 * Guard: no plugin module outside `access.ts` may hard-code a brokered vendor
 * name ("composio" / "arcade") in a provenance or provider comparison.
 *
 * `access.ts` is the one exempt file because it is where the vocabulary lives.
 *
 * This guard is green and must stay green; `access.ts` is the only exemption.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGINS_DIR = join(import.meta.dir, "../src/plugins");

const PATTERNS: RegExp[] = [
  /provenance\s*[!=]==\s*"(composio|arcade)"/,
  /brokeredConnections\.provider\s*,\s*"(composio|arcade)"/,
  /provider:\s*"(composio|arcade)"/,
  // `eq(mcpServers.provenance, "composio")`: the drizzle spelling of the same mistake as the
  // `provenance === "composio"` pattern above. A guard catching one spelling of a mistake and not
  // the other is worse than none, because it is read as coverage.
  /(mcpServers|\w+)\.provenance\s*,\s*"(composio|arcade)"/,
];

test("no plugin module hard-codes a brokered vendor name outside access.ts", () => {
  const offenders: string[] = [];
  const files = readdirSync(PLUGINS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "access.ts")
    .sort();
  for (const file of files) {
    const lines = readFileSync(join(PLUGINS_DIR, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (PATTERNS.some((re) => re.test(line))) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});
