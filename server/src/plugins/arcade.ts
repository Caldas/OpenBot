/**
 * The Arcade transport's vendor-free half. Imports no vendor package and nothing from
 * `arcade-adapter.ts`: the adapter imports this module, never the reverse (see `./broker`, which
 * records that the other direction is a cycle).
 */

/**
 * Whether listing tools needs somebody's credential. It does not: the listing uses the deployment's
 * own Arcade key, and a listing is not a person's.
 */
export const listNeedsCredential = false;

/**
 * Which toolkit this connection is about, from `arcade://Toolkit`.
 *
 * CASE IS PRESERVED AND NOTHING IS NORMALIZED. Arcade's toolkit and action names are case-sensitive
 * and dotted, where Composio's slugs are neither, so a lowercased toolkit reaches nothing:
 * `arcade://Gmail` and `arcade://gmail` are distinct apps.
 *
 * ONE TOOLKIT OR NOTHING. This answer is the name the brokered gate looks a person's row up by, so a
 * url read loosely is one app's connection satisfying a call against another.
 * `arcade://Gmail/messages` must not answer `"Gmail/messages"`: a path segment is not an app.
 *
 * TRIMMED BEFORE THE SLASHES COME OFF, as `composio.ts` does: the other order leaves a space as the
 * last character, so the slash is not at the end and nothing matches.
 */
const TOOLKIT_NAME = /^[A-Za-z0-9_-]+$/;

export function toolkitOf(url: string): string | null {
  const prefix = "arcade://";
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length).trim().replace(/\/+$/, "");
  return TOOLKIT_NAME.test(name) ? name : null;
}
