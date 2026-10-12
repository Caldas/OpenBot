/**
 * The Arcade transport's vendor-free half. Imports no vendor package and nothing from
 * `arcade-adapter.ts`: the adapter imports this module, never the reverse (see `./broker`, which
 * records that the other direction is a cycle).
 */

import { flagOf } from "./broker";

/**
 * Whether listing tools needs somebody's credential. It does not: the listing uses the deployment's
 * own Arcade key, and a listing is not a person's.
 */
export const listNeedsCredential = false;

const TOOLKIT_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Which toolkit this connection is about, from `arcade://Toolkit`.
 *
 * CASE IS PRESERVED AND NOTHING IS NORMALIZED. Arcade's toolkit and action names are case-sensitive,
 * and action names are dotted (`Apollo.EnrichOrganization`: the dot separates toolkit from action,
 * so a toolkit name never contains one and `TOOLKIT_NAME` rightly rejects it), where Composio's
 * slugs are neither, so a lowercased toolkit reaches nothing:
 * `arcade://Gmail` and `arcade://gmail` are distinct apps.
 *
 * ONE TOOLKIT OR NOTHING. This answer is the name the brokered gate looks a person's row up by, so a
 * url read loosely is one app's connection satisfying a call against another.
 * `arcade://Gmail/messages` must not answer `"Gmail/messages"`: a path segment is not an app.
 *
 * TRIMMED BEFORE THE SLASHES COME OFF, as `composio.ts` does: the other order leaves a space as the
 * last character, so the slash is not at the end and nothing matches.
 */
export function toolkitOf(url: string): string | null {
  const prefix = "arcade://";
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length).trim().replace(/\/+$/, "");
  return TOOLKIT_NAME.test(name) ? name : null;
}

/**
 * What a tool does, from `metadata.behavior`. DESTRUCTIVE IS READ FIRST, and the order is the
 * decision: a reading that checked `read_only` first would record a both-flagged tool as a READ,
 * the one direction nothing downstream recovers from, since nothing ever asks again.
 *
 * ABSENT METADATA, OR A FLAG THAT `flagOf` ANSWERS NULL (a vendor publishing a string where it
 * documents a boolean), IS A DESTRUCTIVE WRITE, which is also what a listing that would not say
 * already records in `./mcp`. It fails safe by putting an approval in front of a read, which is
 * annoying and correct; the alternative lets a deletion through unannounced.
 */
export function classify(metadata: unknown): {
  effect: "read" | "write";
  destructive: boolean;
} {
  const closed = { effect: "write", destructive: true } as const;
  if (typeof metadata !== "object" || metadata === null) return closed;
  const behavior = (metadata as { behavior?: unknown }).behavior;
  if (typeof behavior !== "object" || behavior === null) return closed;
  const flags = behavior as { destructive?: unknown; read_only?: unknown };
  const destructive = flagOf(flags.destructive, false);
  const readOnly = flagOf(flags.read_only, false);
  if (destructive === null || readOnly === null) return closed;
  if (destructive) return { effect: "write", destructive: true };
  if (readOnly) return { effect: "read", destructive: false };
  return { effect: "write", destructive: false };
}
