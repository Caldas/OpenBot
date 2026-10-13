import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type { ConsentAction } from "./enablement-notes";

/**
 * What one account holds at one app, action by action, as `GET /servers/:id/grants` answers it.
 *
 * The same four states the server's `GrantState` names. Declared here rather than imported because
 * `app/` never imports from `server/`; the route's own docblock is the contract.
 */
export type GrantState =
  | { action: string; state: "authorized"; scopes: string[] }
  | { action: string; state: "needs-consent"; scopes: string[] }
  | { action: string; state: "needs-operator"; missing: string[] }
  | { action: string; state: "unknown"; reason: string };

export const grantKeys = {
  forServer: (serverId: string) => ["plugins", "grants", serverId] as const,
};

export function grantsQueryOptions(serverId: string, enabled: boolean) {
  return queryOptions({
    queryKey: grantKeys.forServer(serverId),
    enabled,
    queryFn: async (): Promise<GrantState[]> => {
      const response = await client(
        `/api/plugins/servers/${encodeURIComponent(serverId)}/grants`,
        { fallback: "What this account holds could not be read." },
      );
      const body: { actions?: unknown } = await response.json();
      return Array.isArray(body.actions) ? (body.actions as GrantState[]) : [];
    },
  });
}

/**
 * Begin authorizing ONE action. Answers the vendor's consent url, which the caller navigates to.
 *
 * `null` rather than `undefined` for the reason spelled out over `connectAccountMutationOptions`.
 */
export function authorizeActionMutationOptions(
  returnTo: "settings" | "admin" = "settings",
) {
  return mutationOptions({
    mutationFn: async (variables: {
      serverId: string;
      action: string;
    }): Promise<string | null> => {
      const authorizationUrl = await client<string | undefined>(
        `/api/plugins/servers/${encodeURIComponent(variables.serverId)}/authorize?returnTo=${returnTo}`,
        "authorizationUrl",
        {
          method: "POST",
          body: { action: variables.action },
          fallback: "That action could not be authorized.",
        },
      );
      return authorizationUrl ?? null;
    },
  });
}

/**
 * Whether this answer is the route's synthetic "could not read".
 *
 * WHEN `grantsFor` THROWS, THE ROUTE ANSWERS 200 WITH ONE `unknown` ENTRY WHOSE `action` IS THE
 * TOOLKIT NAME: a throw yields no action names to enumerate, so that label is not an action and must
 * never be drawn as one. Recognised as a sole `unknown` entry that is either the app's own name or
 * not shaped like an action at all (an Arcade action is dotted, `Toolkit.Action`; a toolkit is not).
 */
export function couldNotRead(
  grants: readonly GrantState[],
  appNames: readonly string[],
): boolean {
  if (grants.length !== 1) return false;
  const [only] = grants;
  if (only?.state !== "unknown") return false;
  const label = only.action.toLowerCase();
  return (
    appNames.some((name) => name.toLowerCase() === label) ||
    !only.action.includes(".")
  );
}

/** The actions the consent copy reasons about: those that name a permission or could be asked for. */
export function consentActionsFrom(
  grants: readonly GrantState[],
): ConsentAction[] {
  const actions: ConsentAction[] = [];
  for (const grant of grants) {
    if (grant.state === "authorized" || grant.state === "needs-consent") {
      actions.push({ name: grant.action, scopes: grant.scopes });
    }
  }
  return actions;
}

export type GrantGroup = {
  /** The permissions every action in the group requires; empty for the whole-app and no-permission groups. */
  scopes: string[];
  /** "whole-app" when no action in the app names a permission; "none" for actions that name none. */
  kind: "scoped" | "whole-app" | "none";
  grants: GrantState[];
};

function scopesOf(grant: GrantState): string[] {
  return grant.state === "authorized" || grant.state === "needs-consent"
    ? [...new Set(grant.scopes)].sort()
    : [];
}

/** The one state ordering: `groupGrants` sorts by it and `GrantList` picks its unauthorized tail by it. */
export const RANK: Record<GrantState["state"], number> = {
  authorized: 0,
  "needs-consent": 1,
  "needs-operator": 2,
  unknown: 3,
};

/**
 * The grant list grouped by the permission each action requires, so what is drawn after a consent
 * matches what the consent screen said.
 *
 * AN ALL-OR-NOTHING APP IS ONE GROUP CONTAINING EVERYTHING: when no action names a permission there
 * is nothing to group on, and one group is the honest rendering rather than a degraded one. Names
 * are compared exactly and never case-folded: Arcade's are case-sensitive.
 */
export function groupGrants(grants: readonly GrantState[]): GrantGroup[] {
  const anyScoped = grants.some((grant) => scopesOf(grant).length > 0);
  const ordered = [...grants].sort(
    (left, right) =>
      RANK[left.state] - RANK[right.state] ||
      left.action.localeCompare(right.action),
  );
  if (!anyScoped) {
    return ordered.length > 0
      ? [{ scopes: [], kind: "whole-app", grants: ordered }]
      : [];
  }
  const groups = new Map<string, GrantGroup>();
  for (const grant of ordered) {
    const scopes = scopesOf(grant);
    const key = scopes.join("\u0000");
    let group = groups.get(key);
    if (!group) {
      group = {
        scopes,
        kind: scopes.length > 0 ? "scoped" : "none",
        grants: [],
      };
      groups.set(key, group);
    }
    group.grants.push(grant);
  }
  return [...groups.values()].sort(
    (left, right) =>
      Number(left.kind === "none") - Number(right.kind === "none") ||
      left.scopes.join(",").localeCompare(right.scopes.join(",")),
  );
}
