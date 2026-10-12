/**
 * The Arcade transport's vendor-free half. Imports no vendor package and nothing from
 * `arcade-adapter.ts`: the adapter imports this module, never the reverse (see `./broker`, which
 * records that the other direction is a cycle).
 */

import { flagOf } from "./broker";
import type { ListedTool } from "./mcp";

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

/**
 * What this transport needs of Arcade's client, and nothing more: `./arcade-adapter` maps the
 * vendor's SDK onto it, so this file imports no vendor package. Mirrors `ComposioActions`.
 *
 * `listTools` carries no `user_id` by construction: the query type has no such field.
 */
export type ArcadeActions = {
  listTools(q: {
    toolkit: string;
    limit: number;
    offset: number;
  }): Promise<{ items: unknown[]; total_count?: number }>;
  execute(r: {
    tool_name: string;
    input: Record<string, unknown>;
    user_id: string;
  }): Promise<unknown>;
};

let installed: ArcadeActions | null = null;

/** Installs (or, with `null`, removes) the Arcade client. Null is also the unconfigured state. */
export function useArcadeClient(client: ArcadeActions | null): void {
  installed = client;
}

export type ArcadeListedTool = ListedTool & { scopes: string[] };

const PAGE_SIZE = 100;
/** A runaway guard, not a bound: 1000 pages of 100 is far past any one toolkit. */
const MAX_PAGES = 1000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The OAuth scopes an action needs: `requirements.authorization.oauth2.scopes`.
 *
 * NEVER `requirements.met`. The two sit in the same object and behave oppositely: `met` is a
 * per-person claim that answers TRUE FOR EVERYBODY when asked without a `user_id` (and this
 * listing sends none), while `scopes` is a static property of the action that carries no identity.
 * Reading `met` here would record every person as connected to everything, and nothing else would
 * go red: the gate would pass, the call would be made, and the first sign would be somebody
 * else's mailbox.
 */
function scopesOf(requirements: unknown): string[] {
  const scopes = record(
    record(record(requirements)?.authorization)?.oauth2,
  )?.scopes;
  return Array.isArray(scopes)
    ? scopes.filter((s): s is string => typeof s === "string")
    : [];
}

function inputSchemaOf(input: unknown): Record<string, unknown> {
  const parameters = record(input)?.parameters;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const raw of Array.isArray(parameters) ? parameters : []) {
    const parameter = record(raw);
    if (!parameter || typeof parameter.name !== "string") continue;
    const valType = record(parameter.value_schema)?.val_type;
    properties[parameter.name] = {
      type: valType === "json" ? "object" : (valType ?? "string"),
      description:
        typeof parameter.description === "string" ? parameter.description : "",
    };
    if (parameter.required === true) required.push(parameter.name);
  }
  return { type: "object", properties, required };
}

/**
 * Every action of one toolkit, read to the end.
 *
 * NO `user_id` IS SENT. A listing is not somebody's: it is what this deployment offers everybody.
 *
 * PAGINATION STOPS ON A SHORT PAGE, never on `total_count`. That field is optional; an earlier draft
 * fell back to `?? tools.length` and so exited after one page. It is used only as a cross-check.
 */
export async function listTools(connection: {
  url: string;
}): Promise<ArcadeListedTool[]> {
  const toolkit = toolkitOf(connection.url);
  if (!toolkit) {
    throw new Error(
      `${connection.url} does not name an Arcade toolkit, so nothing was asked what it offers. The url has to be arcade:// followed by a toolkit name; correct it on the Plugins page.`,
    );
  }
  if (!installed) {
    throw new Error(
      `Arcade is not configured for this deployment, so nothing could be asked what ${toolkit} offers. The actions already recorded for this app are kept rather than cleared.`,
    );
  }

  const raw: unknown[] = [];
  let total: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await installed.listTools({
      toolkit,
      limit: PAGE_SIZE,
      offset: raw.length,
    });
    const items = (answer as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw new Error(
        `Arcade did not answer with an action list for ${toolkit}. Nothing was refreshed and the actions already recorded for this app are kept.`,
      );
    }
    raw.push(...items);
    if (typeof answer.total_count === "number") total = answer.total_count;
    if (items.length < PAGE_SIZE) break;
  }
  if (total !== undefined && raw.length < total) {
    throw new Error(
      `Arcade listed ${raw.length} of ${total} actions for ${toolkit}, so the listing is incomplete. Nothing was refreshed and the actions already recorded for this app are kept.`,
    );
  }

  return raw.flatMap((item) => {
    const tool = record(item);
    if (!tool || typeof tool.qualified_name !== "string") return [];
    return [
      {
        name: tool.qualified_name,
        description:
          typeof tool.description === "string" ? tool.description : "",
        inputSchema: inputSchemaOf(tool.input),
        ...classify(tool.metadata),
        scopes: scopesOf(tool.requirements),
      },
    ];
  });
}
