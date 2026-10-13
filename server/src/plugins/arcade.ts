/**
 * The Arcade transport's vendor-free half. Imports no vendor package and nothing from
 * `arcade-adapter.ts`: the adapter imports this module, never the reverse (see `./broker`, which
 * records that the other direction is a cycle).
 */

import { cutAtCodeUnits } from "../channels/text";
import { flagOf } from "./broker";
import { type ListedTool, MAX_RESULT_CHARS, type McpCallResult } from "./mcp";

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
  }): Promise<{
    success?: boolean;
    output?: {
      value?: unknown;
      error?: { message?: string };
      authorization?: unknown;
    };
  }>;
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
  let exhausted = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    let answer: { items: unknown[]; total_count?: number };
    try {
      answer = await installed.listTools({
        toolkit,
        limit: PAGE_SIZE,
        offset: raw.length,
      });
    } catch (error) {
      /*
       * A SENTENCE, NOT THE VENDOR'S OBJECT, as `composio.ts`'s listing does. `refreshTools` puts
       * `error.message` on the admin page and into a model's context, and an SDK `APIError` builds
       * its message from the whole response body: an unsanitised vendor payload. The original is
       * kept as `cause` for a log.
       */
      throw new Error(listingSentence(toolkit, error), { cause: error });
    }
    const items = (answer as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw new Error(
        `Arcade did not answer with an action list for ${toolkit}. Nothing was refreshed and the actions already recorded for this app are kept.`,
      );
    }
    raw.push(...items);
    // THE HIGHEST ANY PAGE REPORTED, NEVER THE LAST. An engine that truncates at 250 of 300 drops
    // `total_count` from its short final page, and keeping the last value would erase the 300 page
    // one reported and commit 250 actions as a complete listing. (`total_count` reaching here is
    // already honest about absence: `createArcadeClient` omits the field when the vendor omitted
    // it, because the SDK's page object coerces an absent total to `0`.)
    if (typeof answer.total_count === "number") {
      total =
        total === undefined
          ? answer.total_count
          : Math.max(total, answer.total_count);
    }
    if (items.length < PAGE_SIZE) {
      exhausted = false;
      break;
    }
  }
  if (exhausted) {
    throw new Error(
      `Arcade's listing for ${toolkit} never ended after ${MAX_PAGES} pages, so it is not trusted to be a list of this app's actions. Nothing was refreshed and the actions already recorded for this app are kept.`,
    );
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

/** What this deployment says when Arcade's listing could not be read. Never the vendor's words. */
function listingSentence(toolkit: string, _error: unknown): string {
  return `Arcade's action list for ${toolkit} could not be read, so nothing was refreshed and the actions already recorded for this app are kept.`;
}

/**
 * A failure from Arcade, already normalized and cause-unwrapped by `./arcade-adapter`, so nothing
 * here sees an SDK class. `name` is the RESPONSE BODY's `error.name`.
 */
export type ArcadeFailure = {
  status: number | undefined;
  name: string | undefined;
  message: string | undefined;
};

/**
 * KEYED ON THE BODY'S NAME, NEVER ON THE 403. A 403 is also what a revoked key, a disabled project
 * and a rate limit look like; keyed on the status, this would tell somebody to authorize an action
 * when the deployment's key is what is wrong.
 */
export function isAuthorizationRequired(failure: ArcadeFailure): boolean {
  return failure.name === "tool_authorization_required";
}

/**
 * The thrown value, READ AS A SHAPE rather than cast into one. `record` is a plain-object coercion
 * that normalizes nothing and walks no `cause`, so a cast through it would let any object at all
 * stand in for a normalized failure. Only a `name` string is required, since that is the one field
 * `isAuthorizationRequired` keys on; the rest are read as-is or left undefined.
 */
function arcadeFailure(thrown: unknown): ArcadeFailure | null {
  const raw = record(thrown);
  if (!raw || typeof raw.name !== "string") return null;
  return {
    status: typeof raw.status === "number" ? raw.status : undefined,
    name: raw.name,
    message: typeof raw.message === "string" ? raw.message : undefined,
  };
}

/**
 * The cap every string this module puts in front of a model goes through, as `composio.ts`'s
 * `cap()` does, with the same limit and the same marker.
 *
 * A tool result is read by a model AND copied into the audit row, so an unbounded one is somebody
 * else's server deciding how much of our context window to spend and how large a durable record
 * grows — and the text is attacker-influenceable, since it is whatever the mailbox, issue or
 * document the action read happens to contain. Truncated visibly, never silently: `truncated` is
 * the field that says it happened, and reporting `false` unconditionally made it a field that
 * structurally could not.
 *
 * BOTH ANSWERS GO THROUGH IT. A refusal lands in a model's context exactly as a result does, and
 * this file's refusals quote `toolName`, which is a `qualified_name` the vendor's listing supplied.
 */
function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_RESULT_CHARS) return { text, truncated: false };
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated]`,
    truncated: true,
  };
}

const failureResult = (text: string): McpCallResult => ({
  ...cap(text),
  isError: true,
});

/**
 * Call one Arcade action as the connection's actor.
 *
 * THE ACTION IN THE REFUSAL COMES FROM THE CALL SITE, never from the error: `APIError` in
 * `@arcadeai/arcadejs@2.4.1` carries `status`, `headers` and `error` and nothing naming the tool.
 *
 * NO URL IS EVER IN THE SENTENCE, ON ANY PATH. The `authorization.url` is a bearer capability:
 * whoever opens it attaches an account to the identity the flow was minted for. It is never
 * returned to a model, logged, put in an error body or written to an audit row. The refusal names
 * the Settings page, where the link is minted by an authenticated request whose actor is known.
 *
 * THE SUCCESS PATH IS COVERED BY THAT SAME PROMISE, and this is where it is easiest to break. A 200
 * is not a safe envelope: `ExecuteToolResponse.output.authorization` is the SAME
 * `AuthorizationResponse` the 403 carries, with the url and a `context.token` that is a LIVE OAUTH
 * ACCESS TOKEN for the end user's account. `output.value` IS THE ONLY PART OF THE ENVELOPE THAT MAY
 * CROSS INTO `text`; the envelope is never stringified whole, because `text` is returned to a model
 * and copied into the audit row. An answer carrying an `authorization` at all is the refusal, not a
 * result: it means the call was not run as an authorized actor.
 *
 * NOTHING THE VENDOR SAID IS REPEATED either: the ordinary failure is this deployment's sentence,
 * and `output.error` is read only as a BOOLEAN — its `message`, `developer_message` and
 * `stacktrace` are the vendor's words and stay out of `text`.
 */
export async function callTool(
  connection: { url: string; actorId?: string },
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  if (!installed) {
    return failureResult(
      `Arcade is not configured for this deployment, so ${toolName} was not run.`,
    );
  }
  if (!connection.actorId) {
    return failureResult(
      `${toolName} was not run: no account was named to run it as.`,
    );
  }
  try {
    const answer = await installed.execute({
      tool_name: toolName,
      input: args,
      user_id: connection.actorId,
    });
    if (answer.output?.authorization) {
      return failureResult(
        `${toolName} has not been authorized on this account yet. Authorize it in Settings → Connected accounts and ask again.`,
      );
    }
    if (answer.success === false || answer.output?.error) {
      return failureResult(`Arcade could not run ${toolName}.`);
    }
    const value = JSON.stringify(answer.output?.value ?? null, null, 2);
    /*
     * `JSON.stringify` ANSWERS `undefined` RATHER THAN THROWING for a value with no JSON form — a
     * function, a symbol — and `output.value` is the vendor's field while the `unknown` saying
     * anything may be there is ours. `??` does not catch it: a function is not nullish. Named here
     * so the refusal is this deployment's sentence rather than a `text.length` TypeError raised
     * inside {@link cap} and caught below as if Arcade had failed.
     */
    if (value === undefined) {
      return failureResult(
        `${toolName} ran, but its answer has no JSON form, so there is nothing to show.`,
      );
    }
    return { ...cap(value), isError: false };
  } catch (thrown) {
    const failure = arcadeFailure(thrown);
    if (failure && isAuthorizationRequired(failure)) {
      return failureResult(
        `${toolName} has not been authorized on this account yet. Authorize it in Settings → Connected accounts and ask again.`,
      );
    }
    return failureResult(`Arcade could not run ${toolName}.`);
  }
}
