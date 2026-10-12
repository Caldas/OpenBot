import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { consentCopy } from "@/lib/plugins/enablement-notes";
import {
  authorizeActionMutationOptions,
  consentActionsFrom,
  couldNotRead,
  type GrantGroup,
  type GrantState,
  grantsQueryOptions,
  groupGrants,
} from "@/lib/plugins/grants";

/**
 * What one account holds at one app, action by action, grouped by the permission each action needs.
 *
 * ONE ROW PER ACTION, DRAWN FROM ITS `GrantState` AND NOTHING ELSE. Authorize is offered for
 * `needs-consent` only: a `needs-operator` action is blocked by a deployment secret that no amount
 * of consenting moves, and an `unknown` one offers a Retry, because not knowing is not the same as
 * not connected and telling somebody to authorize what they already authorized sends them round
 * twice.
 *
 * NO ORDERING BY "RECENTLY REFUSED". Authorized actions come first and everything else sits behind
 * the search; there is no per-person, per-app refusal read on any route this page can call, and
 * inventing a column to order on would be a claim this page could not back.
 */
export function GrantList({
  serverId,
  appNames,
  canAuthorize,
  landedAction,
  returnTo,
}: {
  serverId: string;
  /** Every name this app goes by, so the route's synthetic toolkit-named entry is recognised. */
  appNames: readonly string[];
  /** Whether this viewer may mint a consent. State is shown to everyone; minting is not. */
  canAuthorize: boolean;
  landedAction: string | null;
  returnTo: "settings" | "admin";
}) {
  const grants = useQuery(grantsQueryOptions(serverId, true));
  const [search, setSearch] = useState("");
  const [choosing, setChoosing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const authorize = useMutation({
    ...authorizeActionMutationOptions(returnTo),
    onError: (thrown: Error) => setNotice(thrown.message),
    /* A full page navigation: the consent screen is the vendor's own and shown in this browser. */
    onSuccess: (authorizationUrl) => {
      if (authorizationUrl === null) {
        setNotice(
          "This deployment answered without a consent link, so there was nowhere to send you and nothing was authorized. Try again, and tell an administrator if it persists.",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  if (grants.isPending) return null;
  if (grants.error) {
    return (
      <PageSection title="Actions">
        <p className="text-destructive text-sm" role="alert">
          Could not read what this account holds just now, so nothing is said
          about it either way.{" "}
          <Button
            onClick={() => grants.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </p>
      </PageSection>
    );
  }

  const all = grants.data ?? [];
  if (couldNotRead(all, appNames)) {
    const [only] = all;
    return (
      <PageSection title="Actions">
        {/* Not an action: the entry's label is the toolkit's own name, which a person must not
            see in their grant list as if it were one. */}
        <p data-could-not-read="" role="status" className="text-sm">
          Could not read what this account holds just now, so nothing is said
          about it either way.
          {only?.state === "unknown" ? ` ${only.reason}` : null}{" "}
          <Button
            onClick={() => grants.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </p>
      </PageSection>
    );
  }

  const term = search.trim().toLowerCase();
  const visible = (grant: GrantState) =>
    term.length > 0
      ? grant.action.toLowerCase().includes(term)
      : grant.state === "authorized";
  const hidden = term.length > 0 ? 0 : all.filter((g) => !visible(g)).length;
  const groups: GrantGroup[] = groupGrants(all.filter(visible));
  const consentActions = consentActionsFrom(all);

  return (
    <PageSection
      description="Grouped by the permission each action asks for, so what is here after you authorize matches what the consent screen said."
      title="Actions"
    >
      {notice ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}
      <Input
        aria-label="Search actions"
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search actions"
        type="search"
        value={search}
      />
      {groups.map((group) => (
        <div
          data-grant-group={
            group.kind === "scoped" ? group.scopes.join(", ") : group.kind
          }
          key={group.scopes.join("\u0000") || group.kind}
        >
          <p className="mb-1 text-muted-foreground text-xs">
            {group.kind === "whole-app"
              ? "Everything in this app, approved together"
              : group.kind === "none"
                ? "Asks for no permission of its own"
                : `Needs ${group.scopes.join(", ")}`}
          </p>
          <PageRows>
            {group.grants.map((grant) => (
              <Item
                data-action={grant.action}
                data-landed={grant.action === landedAction ? "" : undefined}
                data-state={grant.state}
                key={grant.action}
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>{grant.action}</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {describe(grant, canAuthorize)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {grant.state === "needs-consent" && canAuthorize ? (
                    <Button
                      onClick={() => {
                        setNotice(null);
                        setChoosing(grant.action);
                      }}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Authorize
                    </Button>
                  ) : null}
                  {grant.state === "unknown" ? (
                    <Button
                      onClick={() => grants.refetch()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Retry
                    </Button>
                  ) : null}
                </ItemActions>
              </Item>
            ))}
          </PageRows>
        </div>
      ))}
      {hidden > 0 ? (
        <p className="text-muted-foreground text-sm">
          {hidden} more {hidden === 1 ? "action" : "actions"} not yet
          authorized. Search to find {hidden === 1 ? "it" : "one"}.
        </p>
      ) : null}
      {term.length > 0 && groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No action matches that search.
        </p>
      ) : null}
      {choosing !== null ? (
        <ConsentNotice
          action={choosing}
          busy={authorize.isPending}
          onCancel={() => setChoosing(null)}
          onContinue={() => authorize.mutate({ serverId, action: choosing })}
          sentence={consentCopy(choosing, consentActions).sentence}
        />
      ) : null}
    </PageSection>
  );
}

/**
 * What somebody reads immediately before being sent to a consent screen. The sentence is
 * `consentCopy`'s and is rendered as it came, never reworded here.
 */
function ConsentNotice({
  action,
  busy,
  sentence,
  onCancel,
  onContinue,
}: {
  action: string;
  busy: boolean;
  sentence: string;
  onCancel: () => void;
  onContinue: () => void;
}) {
  return (
    <fieldset
      aria-label={`Before you authorize ${action}`}
      className="m-0 flex min-w-0 flex-col gap-2 rounded-lg border p-3"
      data-consent-copy=""
    >
      <p className="text-sm">{sentence}</p>
      <div className="flex gap-2">
        <Button
          disabled={busy}
          onClick={onContinue}
          size="sm"
          type="button"
          variant="outline"
        >
          Continue to consent
        </Button>
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}

function describe(grant: GrantState, canAuthorize: boolean): string {
  switch (grant.state) {
    case "authorized":
      return "Authorized.";
    case "needs-consent":
      return canAuthorize
        ? "Not authorized yet."
        : "Not authorized yet. An administrator can authorize it.";
    case "needs-operator":
      return grant.missing.length > 0
        ? `Missing ${grant.missing.join(", ")}. An administrator sets it on this deployment; authorizing cannot fix it.`
        : "A setting on this deployment is missing. An administrator sets it; authorizing cannot fix it.";
    case "unknown":
      return `Could not read this one just now. ${grant.reason}`;
  }
}
