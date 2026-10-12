// app/tests/arcade-no-browser-calls.test.ts
/**
 * Guard: no browser code under `app/src` ever dials Arcade.
 *
 * WHY: the vendor key never leaves the server and the browser never talks to
 * Arcade (spec D25). The grant-status route exists precisely so a browser asks
 * OpenBot rather than the vendor. A direct dial from `app/` would either need
 * the deployment's key in the bundle or would leak which identities have flows
 * outstanding.
 *
 * Flags any line that imports `@arcadeai/arcadejs` (static, dynamic `import(`,
 * or `require(`), names an `arcade.dev` host, or names an Arcade API path.
 *
 * NOT AN OFFENCE: an `arcade://` url string. That is a brokered row's url, as
 * the server hands it to the browser, and is not a network target. It is
 * excluded explicitly below (and does not match the host pattern anyway); do
 * not widen the host pattern to bare "arcade" or this guard starts crying wolf
 * and gets weakened.
 *
 * EXPECTED GREEN. Unlike brokered-provenance.test.ts (committed RED as a
 * checklist), no browser Arcade code exists, so this passes from the start.
 * If it goes red, remove the offending browser code; do not loosen the guard.
 * The scan-count assertion stops it passing vacuously against an empty walk.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "../src");

const PATTERNS: RegExp[] = [
  /@arcadeai\/arcadejs/,
  /\barcade\.dev\b/,
  /\/v1\/tools\/execute/,
  /\/v1\/tools\/authorize/,
  /oauth\/confirm_user/,
];

// `arcade://` is a row url, not a dial. Blanked before matching.
const ROW_URL = /arcade:\/\/\S*/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

test("no browser code under app/src dials Arcade", () => {
  const files = walk(SRC_DIR);
  expect(files.length).toBeGreaterThan(50);
  const offenders: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const text = line.replace(ROW_URL, "");
      if (PATTERNS.some((re) => re.test(text))) {
        offenders.push(`${file.slice(SRC_DIR.length + 1)}:${i + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
});
