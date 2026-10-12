import type { ComposioApp } from "./queries";

/**
 * What a directory row says about an app before anybody presses Add.
 *
 * Pure, and in a `.ts` file rather than beside the screen, so the three decisions a row rests on can
 * be asserted without a DOM, a router and a query client — and so the screen that draws them is free
 * to be a provider-blind component rather than a route.
 */

/**
 * The D8 coverage warning for an app, or null when there is nothing to say.
 *
 * Driven by `classifiedCount` against `actionCount` and nothing else. `classifiedCount: 0` is
 * MEASURED, nothing classified, so it warns; `null` is NOT MEASURED (a Composio app) so it says
 * nothing. Those are opposite sentences, and `?? 0` would collapse one into the other.
 *
 * The classification is measured server-side from the fetched listing and never re-derived here:
 * never inferred from the `Api` suffix (Arcade's naming convention, not a contract — a guess wearing
 * a measurement's clothes), and never from `classify()`'s verdict, which is TOTAL: its closed
 * destructive-write verdict for absent metadata is byte-identical to its verdict for a genuinely
 * destructive action, so counting "did classify return something" counts nothing.
 *
 * Phrased as what it will feel like, not as a percentage.
 */
export function coverageWarning(
  app: Pick<ComposioApp, "actionCount" | "classifiedCount">,
): string | null {
  if (app.classifiedCount === null) return null;
  if (app.actionCount > 0 && app.classifiedCount === 0) {
    return "This provider has not said which of its actions only read, so every action is treated as a destructive write and every call will ask for approval.";
  }
  return null;
}

/**
 * The D32 consent-breadth line for an app, or null when there is nothing to say.
 *
 * Read off the counts the server measured from the same listing, never recomputed here. `null` is
 * NOT MEASURED and draws nothing; a measured zero is a different sentence, so no count is ever
 * defaulted with `?? 0`.
 *
 * An action with no scopes is not its own permission: the connection itself is the grant, so any
 * approval covers it. That is why a mixed app says how many actions need no permission of their own,
 * rather than letting one permission over two actions read as "one permission covering both".
 *
 * The wholly-unscoped case is SPLIT ON THE SINGULAR, where its siblings already were. One action is
 * not "all 1 of them": the fixture's only no-permission toolkit has exactly one action, so the
 * grammatical error was the sentence that shipped rather than an edge nobody reaches. The stilted
 * "1 separate permission across 1 action" below is left alone — stilted is not wrong, and "all 1 of
 * them" is a different thing.
 *
 * It states breadth and never confinement. Whether one approval stays inside the action that asked
 * for it is the provider's property, measured per app, so nothing here promises it.
 */
export function consentBreadth(
  app: Pick<
    ComposioApp,
    "actionCount" | "permissionCount" | "scopedActionCount"
  >,
): string | null {
  const { actionCount, permissionCount, scopedActionCount } = app;
  if (permissionCount === null || scopedActionCount === null) return null;
  if (actionCount <= 0) return null;
  if (permissionCount === 0) {
    return actionCount === 1
      ? "This app has a single action, and approving it approves the app."
      : `Approving any action in this app approves all ${actionCount} of them.`;
  }
  const permissions = `${permissionCount} separate ${permissionCount === 1 ? "permission" : "permissions"}`;
  const actions = `${actionCount} ${actionCount === 1 ? "action" : "actions"}`;
  const base = `This app uses ${permissions} across ${actions}.`;
  const unscoped = actionCount - scopedActionCount;
  if (unscoped <= 0) return base;
  return unscoped === 1
    ? `${base} A further 1 requests no permission of its own and becomes callable with any approval here.`
    : `${base} A further ${unscoped} request no permission of their own and become callable with any approval here.`;
}

/**
 * The apps to draw, in the order to draw them.
 *
 * A function rather than a `.sort()` inside the map, so the two things a row is decided from — the
 * order, and the marker saying an app is already here — can be asserted without a DOM, a router and
 * a query client. See `tests/composio-picker.test.tsx`.
 *
 * A copy, because the array belongs to TanStack Query's cache and is the same object on every
 * render; sorting it in place would rewrite what the cache holds. By name rather than by the
 * vendor's own order, which is popularity — useful for a landing page, useless for finding the one
 * app somebody typed half the name of.
 */
export function matchingApps(apps: ComposioApp[]): ComposioApp[] {
  return [...apps].sort((left, right) => left.name.localeCompare(right.name));
}
