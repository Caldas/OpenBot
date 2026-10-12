import Arcade, { APIError } from "@arcadeai/arcadejs";
import type { ArcadeActions, ArcadeFailure } from "./arcade";
import {
  BrokerRefusalError,
  type BrokerApp,
  type ConnectedAppBroker,
} from "./broker";

/**
 * THE VENDOR'S ONLY DOOR INTO THE SERVER. This is the one file under `server/src` that imports
 * `@arcadeai/arcadejs`, so a version bump has exactly this file to be read against, the same
 * convention `createComposioClient` states for its SDK. It imports the transport (`./arcade`) for
 * the `ArcadeFailure` shape; the transport never imports it, because that direction is a cycle and
 * `broker.ts` records why.
 */

/** Deeper than any real wrapping; a bound, so a cyclic `cause` cannot loop. */
const MAX_CAUSE_DEPTH = 16;

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Walk the `cause` chain to the FIRST `APIError` and read its `status` and the response body's
 * `error.name` / `error.message`. The SDK's own fields are `status`, `headers` and `error` (the
 * parsed body); nothing on it names the tool, so nothing here looks for one. No `APIError` anywhere
 * in the chain answers `null`.
 *
 * `status` is undefined for `APIConnectionError` and `APIUserAbortError`, which extend `APIError`:
 * no response was ever read, so the outcome is uncertain, not refused.
 */
export function normalizeArcadeError(error: unknown): ArcadeFailure | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current))
      return null;
    seen.add(current);
    if (current instanceof APIError) {
      const body = current.error;
      const record =
        body !== null && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      return {
        status: typeof current.status === "number" ? current.status : undefined,
        name: textOf(record.name),
        message: textOf(record.message),
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Page size for the catalogue listing. A short page ends it, never `total_count`. */
const CATALOGUE_PAGE_SIZE = 100;
/** A runaway guard, not a bound. */
const CATALOGUE_MAX_PAGES = 1000;

/**
 * Every toolkit Arcade publishes, with `actionCount` taken from the FULL PAGED tool listing.
 *
 * COUNTED, NEVER READ OFF PAGE ONE: `GithubApi` publishes hundreds of actions where `Github`
 * publishes 43, so a first page of 100 would be a wrong answer in the picker. Pagination ends on a
 * short page; `total_count` is optional on the wire and is used only as a cross-check.
 */
async function listApps(client: Arcade): Promise<BrokerApp[]> {
  const counts = new Map<string, BrokerApp>();
  let seen = 0;
  let total: number | undefined;
  let ended = false;
  for (let page = 0; page < CATALOGUE_MAX_PAGES; page += 1) {
    const answer = await client.tools.list({
      limit: CATALOGUE_PAGE_SIZE,
      offset: seen,
    });
    const items = (answer as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw new Error(
        "Arcade did not answer with a tool list, so its app catalogue could not be read.",
      );
    }
    for (const item of items) {
      const toolkit = (
        item as { toolkit?: { name?: unknown; description?: unknown } } | null
      )?.toolkit;
      if (!toolkit || typeof toolkit.name !== "string") continue;
      const standing = counts.get(toolkit.name);
      if (standing) {
        standing.actionCount += 1;
        continue;
      }
      counts.set(toolkit.name, {
        slug: toolkit.name,
        name: toolkit.name,
        description:
          typeof toolkit.description === "string" ? toolkit.description : "",
        logo: null,
        categories: [],
        actionCount: 1,
        connection: { kind: "consent" },
      });
    }
    seen += items.length;
    const reported = (answer as { total_count?: unknown }).total_count;
    if (typeof reported === "number") total = reported;
    if (items.length < CATALOGUE_PAGE_SIZE) {
      ended = true;
      break;
    }
  }
  if (!ended) {
    throw new Error(
      `Arcade's catalogue never ended after ${CATALOGUE_MAX_PAGES} pages, so it is not trusted.`,
    );
  }
  if (total !== undefined && seen < total) {
    throw new Error(
      `Arcade listed ${seen} of ${total} actions, so its app catalogue is incomplete.`,
    );
  }
  return [...counts.values()];
}

const FIELDS_REFUSAL =
  "Arcade has no per-person field entry: what it asks for is a deployment-wide secret (admin.secrets, e.g. GITHUB_SERVER_URL) that an operator sets once for everybody, so a form asking a person to type one would collect a value that is not theirs and share it with everyone. Set it in the Arcade dashboard instead.";

const notYet = (task: string, member: string) => () =>
  Promise.reject(new Error(`${member} is not implemented yet (${task}).`));

/**
 * The Arcade client, in the shape `createComposioClient` returns. `new Arcade({ apiKey })` opens no
 * socket and sends no request, so tests replace the SDK's PROTOTYPE methods before calling this.
 *
 * `execute` REJECTS WITH THE NORMALIZED FAILURE WHEN THERE IS ONE. `callTool` expects an
 * already-normalized, cause-unwrapped `ArcadeFailure`; a raw `APIError`'s `name` is the CLASS name
 * through the prototype chain, never the body's `error.name`, so without this the authorize prompt
 * is unreachable. `null` means "not an SDK error" and the original is rethrown.
 */
export function createArcadeClient(apiKey: string): {
  actions: ArcadeActions;
  broker: ConnectedAppBroker;
} {
  const client = new Arcade({ apiKey });
  const actions: ArcadeActions = {
    listTools: async (q) =>
      await client.tools.list({
        toolkit: q.toolkit,
        limit: q.limit,
        offset: q.offset,
      }),
    execute: async (r) => {
      try {
        return await client.tools.execute({
          tool_name: r.tool_name,
          input: r.input,
          user_id: r.user_id,
        });
      } catch (error) {
        const failure = normalizeArcadeError(error);
        if (failure) throw failure;
        throw error;
      }
    },
  };
  const broker: ConnectedAppBroker = {
    grantIsLocal: false,
    listApps: () => listApps(client),
    // 5.3: no auth config per app. Arcade's equivalent is an auth provider registered once in the
    // dashboard for the whole project, so there is nothing to create or delete here.
    ensureAuthConfig: async () => "not-needed",
    deleteAuthConfig: async () => {},
    // The field-entry pair REFUSES. Composio's field schemes are a person typing their own API key;
    // `admin.secrets` is a deployment-wide secret an operator sets once for everybody.
    connectionFields: () =>
      Promise.reject(new BrokerRefusalError(FIELDS_REFUSAL)),
    connectWithFields: () =>
      Promise.reject(new BrokerRefusalError(FIELDS_REFUSAL)),
    accountName: async ({ account }) => {
      for await (const row of client.admin.userConnections.list({
        user_id: account.vendorUserId,
      })) {
        const info = row.provider_user_info as
          { name?: unknown; login?: unknown } | null | undefined;
        const name = textOf(info?.name) ?? textOf(info?.login);
        if (name) return name;
      }
      return null;
    },
    // 6.1: authorize, and confirm_user (the mint pair; confirm_user is not on this seam yet)
    authorize: notYet("micro-task 6.1", "authorize"),
    // 6.2: isConnected, revoke, revokeAccount (the connection-lifecycle trio).
    // `admin.userConnections.delete` takes `connection_id` (`ac_...`), NOT the `id` (`at_...`) the
    // listing prints first: measured, `at_...` answers 500 and `ac_...` answers 204.
    isConnected: notYet("micro-task 6.2", "isConnected"),
    revoke: notYet("micro-task 6.2", "revoke"),
    revokeAccount: notYet("micro-task 6.2", "revokeAccount"),
    // 6.3: grantsFor and authorizationStatus (the read-only status pair; neither is on this seam
    // yet, so there is no stub to throw). `authorizationStatus` must narrow to
    // `{ status, userId, scopes }` and nothing else: the raw `auth.status` response carries
    // `context.token`, a live provider access token, plus the person's full profile.
  };
  return { actions, broker };
}
