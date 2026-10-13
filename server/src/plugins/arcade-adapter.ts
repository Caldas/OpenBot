import Arcade, { APIError } from "@arcadeai/arcadejs";
import { classify, type ArcadeActions, type ArcadeFailure } from "./arcade";
import {
  BrokerRefusalError,
  flagOf,
  type BrokerApp,
  type ConnectedAppBroker,
  type GrantState,
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
 * WHAT ARCADE ITSELF SENT: the parsed response body, and never the SDK's page object.
 *
 * `OffsetPage`'s constructor MANUFACTURES DEFAULTS for the two fields every listing here reads —
 * `this.items = body.items || []` and `this.total_count = body.total_count || 0` — so a field the
 * vendor never sent presents on the page as a well-formed empty answer. Read off the page, "Arcade
 * sent no items" is INDISTINGUISHABLE FROM "Arcade sent an empty list" and "Arcade sent no total"
 * is INDISTINGUISHABLE FROM "Arcade said zero": the `Array.isArray` guards below can never fire,
 * every `typeof reported === "number"` test passes on an absent field, and a malformed or truncated
 * listing commits as a complete one.
 *
 * `AbstractPage` keeps the parsed body untouched beside it, so the honest values are read from
 * there. The answer's own properties are the fallback for an answer that has NO `body` at all,
 * which is what `admin.authProviders.list` (a plain `APIPromise`, not a page) and every hand-built
 * stub return — those were never passed through a page constructor, so nothing was manufactured.
 */
function sentBody(answer: unknown): Record<string, unknown> | null {
  const page = record(answer);
  if (!page) return null;
  return record(page.body) ?? page;
}

/** The `total_count` Arcade itself sent, or nothing. Read through {@link sentBody}, for its reason. */
function reportedTotalOf(answer: unknown): number | undefined {
  const raw = sentBody(answer)?.total_count;
  return typeof raw === "number" ? raw : undefined;
}

/**
 * The `items` Arcade itself sent, UNCHECKED — the caller's own guard is what decides whether this
 * is a list. Read through {@link sentBody}, for its reason: off the page object, a listing that
 * sent no `items` at all reads as an empty one and no guard anywhere can tell them apart.
 */
function sentItemsOf(answer: unknown): unknown {
  return sentBody(answer)?.items;
}

/**
 * The HIGHEST total any page reported, never the LAST one.
 *
 * Keeping the last page's value loses the same way `reportedTotalOf` describes, one step later: an
 * engine that truncates at 250 of 300 and drops `total_count` on its short page would otherwise
 * erase the 300 that page one reported, and the cross-check would have nothing to compare against.
 */
const highestTotal = (
  total: number | undefined,
  reported: number | undefined,
): number | undefined =>
  reported === undefined
    ? total
    : total === undefined
      ? reported
      : Math.max(total, reported);

/** One listing's page size, runaway guard, page call and the three sentences a failure carries. */
type Listing = {
  pageSize: number;
  maxPages: number;
  page: (offset: number) => Promise<unknown>;
  malformed: string;
  unending: string;
  incomplete: (seen: number, total: number) => string;
};

/**
 * ONE LISTING READ TO ITS END, as a stream of items.
 *
 * PAGINATION ENDS ON A SHORT PAGE, never on `total_count`, which is optional on the wire; the
 * reported total is a CROSS-CHECK and is taken through {@link reportedTotalOf} and
 * {@link highestTotal} so that "the vendor did not say" can never read as "the vendor said zero".
 *
 * THE SDK'S OWN AUTO-PAGINATION IS NOT USED by anything that goes through here, and that is the
 * point: `OffsetPage.nextPageRequestOptions` returns `null` the moment `total_count` is falsy, so
 * `for await (… of client.x.list(…))` silently stops after page one against any engine that omits
 * the field — and the caller cannot tell a complete answer from a first page of it.
 *
 * THE INCOMPLETENESS THROW IS THE LAST THING THIS YIELDS, after every item, so a caller that folds
 * items as they arrive still never sees a short listing finish as a whole one.
 */
async function* pagedItems(listing: Listing): AsyncGenerator<unknown> {
  let seen = 0;
  let total: number | undefined;
  let ended = false;
  for (let index = 0; index < listing.maxPages; index += 1) {
    const answer = await listing.page(seen);
    const items = sentItemsOf(answer);
    if (!Array.isArray(items)) throw new Error(listing.malformed);
    yield* items;
    seen += items.length;
    total = highestTotal(total, reportedTotalOf(answer));
    if (items.length < listing.pageSize) {
      ended = true;
      break;
    }
  }
  if (!ended) throw new Error(listing.unending);
  if (total !== undefined && seen < total) {
    throw new Error(listing.incomplete(seen, total));
  }
}

/** The verdict `classify` falls back to when it could not read a behaviour. See {@link isClassified}. */
const CLOSED_VERDICT = { effect: "write", destructive: true } as const;

/**
 * Whether ARCADE classified this action, as against this deployment falling back for it.
 *
 * `classify` from `./arcade` is the one reading of `metadata.behavior` anywhere here, and it is
 * deliberately TOTAL: anything it cannot read answers the closed `{ write, destructive }` verdict,
 * so an unannotated action is approved like a deletion. That fallback is exactly what must not be
 * counted — counted, `AirtableApi`'s `metadata: null` actions would report as classified, and the
 * coverage warning that exists to name them would never fire.
 *
 * THE CLOSED VERDICT IS ALSO A REAL ANSWER, which is the only subtlety here: `Attio.RemoveFromList`
 * genuinely publishes `destructive: true` and lands on the same pair. So the verdict is read first,
 * and only that one collision is broken — by asking whether Arcade actually sent a `behavior` whose
 * `destructive` flag reads true, through `flagOf`, the same function `classify` reads it with and
 * never a second parse of the wire.
 *
 * NEVER THE `Api` SUFFIX (spec D8). `AirtableApi` and `GithubApi` are unannotated today and
 * `Apollo` is annotated, so the suffix correlates beautifully — and it is Arcade's naming
 * convention rather than a contract. A rule reading it is a guess wearing a measurement's clothes,
 * right until Arcade curates `DatadogApi`.
 */
function isClassified(metadata: unknown): boolean {
  const verdict = classify(metadata);
  if (
    verdict.effect !== CLOSED_VERDICT.effect ||
    verdict.destructive !== CLOSED_VERDICT.destructive
  ) {
    return true;
  }
  const behavior = record(record(metadata)?.behavior);
  return behavior !== null && flagOf(behavior.destructive, false) === true;
}

/** The oauth2 scopes one listed action asks for, by the path `grantStateOf` reads them on. */
function scopesOf(item: unknown): string[] {
  const authorization = record(record(item)?.requirements)?.authorization;
  const scopes = record(authorization)?.oauth2;
  const listed = record(scopes)?.scopes;
  return Array.isArray(listed)
    ? listed.filter((s): s is string => typeof s === "string")
    : [];
}

/**
 * Every toolkit Arcade publishes, with `actionCount` taken from the FULL PAGED tool listing.
 *
 * COUNTED, NEVER READ OFF PAGE ONE: `GithubApi` publishes hundreds of actions where `Github`
 * publishes 43, so a first page of 100 would be a wrong answer in the picker. Pagination ends on a
 * short page; `total_count` is optional on the wire and is used only as a cross-check.
 *
 * THE OTHER THREE FACTS ARE COUNTED IN THIS SAME FOLD, BEFORE THE TOOLS ARE DISCARDED, and that is
 * the whole of why they are free: the listing is already paged to the end for `actionCount`, so no
 * second listing and NO EXTRA VENDOR CALL is made for them.
 *
 * `permissionCount` is the number of DISTINCT NON-EMPTY scope sets, held per toolkit as sorted,
 * joined strings — SORTED BEFORE JOINED, so `[a,b]` and `[b,a]` are one permission asked for twice.
 * An action with NO scopes joins no group: Github's 43 actions all carry an `oauth2` block with no
 * scopes and one read consent flipped 43 of 43 to `met: true`, so "no scopes" means "the connection
 * itself is the grant", not "needs nothing" — such an action is not separately approvable.
 * `scopedActionCount` is what keeps that from reading as one permission covering everything.
 */
async function listApps(client: Arcade): Promise<BrokerApp[]> {
  /**
   * The fold's own tally, with PLAIN NUMBERS. `BrokerApp`'s three counts are nullable because
   * another provider may not measure them; this provider does, on every action it folds, so a
   * nullable accumulator here would only be a null nothing can produce, narrowed at every `+= 1`.
   * `permissions` holds the sorted-and-joined scope sets; empty sets never enter it.
   */
  type Tally = Omit<
    BrokerApp,
    "classifiedCount" | "permissionCount" | "scopedActionCount"
  > & {
    classifiedCount: number;
    scopedActionCount: number;
    permissions: Set<string>;
  };
  const counts = new Map<string, Tally>();
  for await (const item of pagedItems({
    pageSize: CATALOGUE_PAGE_SIZE,
    maxPages: CATALOGUE_MAX_PAGES,
    page: (offset) => client.tools.list({ limit: CATALOGUE_PAGE_SIZE, offset }),
    malformed:
      "Arcade did not answer with a tool list, so its app catalogue could not be read.",
    unending: `Arcade's catalogue never ended after ${CATALOGUE_MAX_PAGES} pages, so it is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} actions, so its app catalogue is incomplete.`,
  })) {
    const toolkit = (
      item as { toolkit?: { name?: unknown; description?: unknown } } | null
    )?.toolkit;
    if (!toolkit || typeof toolkit.name !== "string") continue;
    const classified = isClassified(record(item)?.metadata);
    const scopes = scopesOf(item);
    const standing =
      counts.get(toolkit.name) ??
      ({
        slug: toolkit.name,
        name: toolkit.name,
        description:
          typeof toolkit.description === "string" ? toolkit.description : "",
        logo: null,
        categories: [],
        actionCount: 0,
        classifiedCount: 0,
        scopedActionCount: 0,
        permissions: new Set<string>(),
        connection: { kind: "consent" },
      } satisfies Tally);
    standing.actionCount += 1;
    if (classified) standing.classifiedCount += 1;
    if (scopes.length > 0) {
      standing.scopedActionCount += 1;
      // SORTED, THEN JOINED. The other order makes one permission into two the first time the
      // vendor lists the same scopes in a different sequence.
      standing.permissions.add([...scopes].sort().join(" "));
    }
    counts.set(toolkit.name, standing);
  }
  // `permissionCount` IS READ OFF THE FINISHED SET, never kept per page: a size taken mid-listing
  // is a count of the sets seen so far, which is a different number on every page but the last.
  return [...counts.values()].map(({ permissions, ...app }) => ({
    ...app,
    permissionCount: permissions.size,
  }));
}

const FIELDS_REFUSAL =
  "Arcade has no per-person field entry: what it asks for is a deployment-wide secret (admin.secrets, e.g. GITHUB_SERVER_URL) that an operator sets once for everybody, so a form asking a person to type one would collect a value that is not theirs and share it with everyone. Set it in the Arcade dashboard instead.";

type ConnectionRow = Arcade.Admin.UserConnectionResponse;

/** Page size for the auth-provider configuration listing. A short page ends it, as `listApps`. */
const AUTH_PROVIDER_PAGE_SIZE = 100;
/** A runaway guard, not a bound. */
const AUTH_PROVIDER_MAX_PAGES = 100;

/** Page size for the user-connection listing. A short page ends it, as `listApps`. */
const CONNECTION_PAGE_SIZE = 100;
/** A runaway guard, not a bound. */
const CONNECTION_MAX_PAGES = 100;

/**
 * The INSTANCE ids of every auth provider this project has configured of one TYPE.
 *
 * THERE ARE THREE THINGS AND THEY NEED THREE WORDS. `provider` in this codebase is the BROKER
 * (`arcade`); `authProvider` is the vendor's OAuth provider TYPE (`google`); and this is the third,
 * the provider INSTANCE — an operator's configuration OF a type, which Arcade keys by its own id
 * (`google-openbot`, `arcade-google`, `cpk-poc`). On an auth-provider config `id` is the INSTANCE
 * and `provider_id` is the TYPE. Verbatim from the live project:
 *
 * ```
 * {"id":"cpk-poc",        "provider_id":"github", "type":"oauth2", "status":"active"}
 * {"id":"google-openbot", "provider_id":"google", "type":"oauth2", "status":"active"}
 * {"id":"arcade-google",  "provider_id":"google", "type":"oauth2", "status":"active"}
 * ```
 *
 * A SET AND NEVER ONE ID: `arcade-google` and `google-openbot` are both of type `google`, and a
 * person may hold a connection under either. Reducing to one would drop real connections.
 *
 * PAGED, AND A MALFORMED LISTING THROWS, on `listApps`' argument and with its guards: a truncated
 * config list would silently answer "not connected" for whoever is held under an instance that fell
 * off the end. Folded to lower case on the way in, so the comparison is Amendment 16's.
 */
async function authProviderInstances(
  client: Arcade,
  authProvider: string,
): Promise<Set<string>> {
  const wanted = authProvider.toLowerCase();
  const instances = new Set<string>();
  for await (const item of pagedItems({
    pageSize: AUTH_PROVIDER_PAGE_SIZE,
    maxPages: AUTH_PROVIDER_MAX_PAGES,
    page: (offset) =>
      client.admin.authProviders.list({
        query: { limit: AUTH_PROVIDER_PAGE_SIZE, offset },
      }),
    malformed: `Arcade did not answer with an auth-provider list, so the configurations of ${authProvider} its connections are held under could not be read.`,
    unending: `Arcade's auth-provider list never ended after ${AUTH_PROVIDER_MAX_PAGES} pages, so it is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} auth providers, so its configuration list is incomplete.`,
  })) {
    const config = record(item);
    const instance = textOf(config?.id);
    if (instance && textOf(config?.provider_id)?.toLowerCase() === wanted) {
      instances.add(instance.toLowerCase());
    }
  }
  return instances;
}

/**
 * The connections an account holds under a toolkit's AUTH PROVIDER.
 *
 * FILTERED ON THE PROVIDER, NOT THE TOOLKIT NAME — AND NOT ON THE PROVIDER TYPE EITHER. Both halves
 * of that are measured, and the second is why this reads a third listing rather than comparing two
 * strings.
 *
 * THE TOOLKIT NAME IS THE WRONG SPELLING because a provider equals the toolkit only when an
 * operator happened to name it so (`Github`, `Asana`, `Attio`); one Google connection serves
 * `Gmail` and `GoogleCalendar` both. So the toolkit is resolved through `authProviderOf`, which is
 * where that mapping lives.
 *
 * AND `authProviderOf`'S ANSWER IS ALSO THE WRONG SPELLING FOR A CONNECTION ROW, because
 * `provider_id` MEANS TWO DIFFERENT THINGS ON THE TWO OBJECTS. Measured against the live API:
 *
 * - on a tool listing, `requirements.authorization.provider_id` — what `authProviderOf` reads — is
 *   the provider TYPE: `"google"`;
 * - on a user-connection row, `provider_id` is the provider INSTANCE id, the operator's
 *   configuration: `"google-openbot"`, `"arcade-google"`, `"cpk-poc"`.
 *
 * A connection row's full key set, verbatim, carries NO vendor-type field at all: `id`,
 * `provider_type`, `connection_id`, `connection_status`, `scopes`, `user_id`, `provider_id`,
 * `provider_description`, `provider_user_info` — and `provider_type` is `"oauth2"`, the auth SCHEME
 * rather than the vendor. The instance id is the ONLY link to the vendor. So `"google"` never
 * equals `"google-openbot"`, a direct comparison matches nothing on any real deployment — with
 * Arcade's own default providers too, which are `arcade-google` and `arcade-github` and never the
 * bare type — and `isConnected` reads false, `accountName` null, and `revoke` false WITHOUT
 * SPENDING A DELETE, so nothing is ever revoked at the vendor. Do not "simplify" this back: every
 * fixture that spells the two sides alike hides it.
 *
 * The bridge is {@link authProviderInstances}: the type `authProviderOf` answered is expanded, once
 * per call, into the SET of configured instance ids of that type, and a row matches when its
 * `provider_id` is in that set (case-insensitively — Amendment 16's client-side fold stands). Both
 * the provider and the configuration list are read ONCE per call, never per row.
 *
 * PAGED THROUGH {@link pagedItems}, NEVER THROUGH THE SDK'S `for await (… of … .list(…))`. That
 * iterator asks `OffsetPage.nextPageRequestOptions`, which returns `null` the moment `total_count`
 * is falsy — and the constructor coerces an ABSENT `total_count` to `0`. So against any engine that
 * omits the field, the SDK's own auto-pagination stops after page one: measured at 30 connections
 * served 10 to a page, ONE request went out, `isConnected` answered `true`, `accountName` read a
 * name off page one, and `revoke` DELETED TEN AND ANSWERED `true` while twenty connections stayed
 * live at the vendor. That is the outcome `revoke`'s own comment forbids — a partial ask reading as
 * a clean success. Reading to a SHORT PAGE instead ends on evidence the engine cannot omit, and an
 * unverifiable listing THROWS rather than answering short, so no caller here can mistake a first
 * page for the whole of what somebody holds.
 *
 * A ROW UNDER AN INSTANCE THE CONFIG LIST DOES NOT NAME DOES NOT MATCH — a provider configuration
 * deleted while a connection outlives it. That is fail-closed: the row is left alone rather than
 * deleted on a guess about which vendor it belongs to.
 *
 * AN UNRESOLVED TOOLKIT (`null`) ANSWERS AS NO ROWS and does NOT fall back to the toolkit name: a
 * fallback would silently restore the defect under a different spelling, invisibly against every
 * fixture in the tree. Callers then answer `isConnected` false, `revoke` false (no delete spent),
 * `accountName` null. A malformed listing is different: `authProviderOf` and
 * {@link authProviderInstances} both THROW, and that propagates, onto the Disconnect path included.
 */
async function connectionsFor(
  client: Arcade,
  vendorUserId: string,
  toolkit: string,
): Promise<ConnectionRow[]> {
  const authProvider = await authProviderOf(client, toolkit);
  if (authProvider === null) return [];
  const instances = await authProviderInstances(client, authProvider);
  const rows: ConnectionRow[] = [];
  for await (const item of pagedItems({
    pageSize: CONNECTION_PAGE_SIZE,
    maxPages: CONNECTION_MAX_PAGES,
    page: (offset) =>
      client.admin.userConnections.list({
        user_id: vendorUserId,
        limit: CONNECTION_PAGE_SIZE,
        offset,
      }),
    malformed: `Arcade did not answer with a connection list, so what this account holds at ${toolkit} could not be read.`,
    unending: `Arcade's connection list never ended after ${CONNECTION_MAX_PAGES} pages, so it is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} connections, so what this account holds at ${toolkit} could not be read in full.`,
  })) {
    const row = item as ConnectionRow;
    const instance = textOf(row.provider_id)?.toLowerCase();
    if (instance !== undefined && instances.has(instance)) rows.push(row);
  }
  return rows;
}

/**
 * DELETE TAKES `connection_id` (`ac_...`), NOT `id` (`at_...`). A user-connection row carries both
 * and the listing prints `id` FIRST; the SDK declares `delete(id: string)` and does not say which.
 * Measured against the live API: `at_...` answers 500, `ac_...` answers 204. Reading the obvious
 * field fails only when somebody presses Disconnect, the worst time to find out.
 */
async function deleteConnection(
  client: Arcade,
  connectionId: string | undefined,
): Promise<void> {
  if (!connectionId) {
    throw new Error("Arcade connection has no connection_id to delete.");
  }
  await client.admin.userConnections.delete(connectionId);
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

/**
 * One listed action read into this deployment's vocabulary, or nothing when it has no name.
 *
 * `requirements.met` IS A BOOLEAN WITH TWO UNRELATED CAUSES AND IS NEVER READ HERE. It is false
 * both when the person has not consented and when a deployment-wide secret is unset — the live
 * listing shows `Github` requiring `GITHUB_SERVER_URL`, which an operator sets once for everybody
 * and which no amount of consenting moves. Sending somebody to a consent screen over that one
 * sends them somewhere that cannot help them, so the secrets are read FIRST and answer
 * `needs-operator` with the keys they name.
 *
 * `unknown` IS ITS OWN STATE RATHER THAN A PESSIMISTIC `needs-consent`, because not knowing is not
 * the same as not connected: telling somebody to authorize something they already authorized sends
 * them round twice. So anything the listing does not say clearly answers `unknown` with the reason.
 */
function grantStateOf(item: unknown): GrantState[] {
  const tool = record(item);
  const action = textOf(tool?.qualified_name);
  if (!action) return [];
  const requirements = record(tool?.requirements);

  const rawSecrets = requirements?.secrets;
  const missing: string[] = [];
  let secretUnreadable = false;
  for (const raw of Array.isArray(rawSecrets) ? rawSecrets : []) {
    const secret = record(raw);
    const key = textOf(secret?.key);
    if (!key) {
      secretUnreadable = true;
      continue;
    }
    if (secret?.met === false) missing.push(key);
    else if (secret?.met !== true) secretUnreadable = true;
  }
  if (missing.length > 0) return [{ action, state: "needs-operator", missing }];
  if (secretUnreadable) {
    return [
      {
        action,
        state: "unknown",
        reason:
          "Arcade listed a deployment secret for this action without saying whether it is set.",
      },
    ];
  }

  const authorization = record(requirements?.authorization);
  if (!authorization) {
    return [
      {
        action,
        state: "unknown",
        reason:
          "Arcade's listing named no authorization for this action, so what this account holds could not be read.",
      },
    ];
  }
  const oauth2 = record(authorization.oauth2)?.scopes;
  const scopes = Array.isArray(oauth2)
    ? oauth2.filter((s): s is string => typeof s === "string")
    : [];
  const tokenStatus = textOf(authorization.token_status);
  const status = textOf(authorization.status);
  if (tokenStatus === "completed" || (!tokenStatus && status === "active")) {
    return [{ action, state: "authorized", scopes }];
  }
  if (
    tokenStatus === "not_started" ||
    tokenStatus === "pending" ||
    tokenStatus === "failed" ||
    status === "inactive"
  ) {
    return [{ action, state: "needs-consent", scopes }];
  }
  return [
    {
      action,
      state: "unknown",
      reason:
        "Arcade's listing gave this action's authorization neither a status nor a token status.",
    },
  ];
}

/**
 * What one account holds at one app, action by action.
 *
 * THIS IS THE ONE PLACE A `user_id` IS SENT ON A LISTING. The transport's `listTools` sends none
 * and reads no per-person state off the answer, because a catalogue is the same for everybody and a
 * per-person listing would make it one person's. Here the question IS about a person, so the
 * account's vendor id goes out with it.
 *
 * PAGED TO THE END, as `listApps` is and for its reason: this answers ONE `GrantState` PER ACTION,
 * so a single first page would quietly drop every action past it — `GithubApi` publishes hundreds —
 * and the grants screen would show a partial holding as the whole of one. A short page ends it and
 * an unverifiable listing throws; see {@link pagedItems}.
 */
async function grantsFor(
  client: Arcade,
  vendorUserId: string,
  toolkit: string,
): Promise<GrantState[]> {
  const grants: GrantState[] = [];
  for await (const item of pagedItems({
    pageSize: CATALOGUE_PAGE_SIZE,
    maxPages: CATALOGUE_MAX_PAGES,
    page: (offset) =>
      client.tools.list({
        toolkit,
        user_id: vendorUserId,
        limit: CATALOGUE_PAGE_SIZE,
        offset,
      }),
    malformed: `Arcade did not answer with an action list for ${toolkit}, so what this account holds there could not be read.`,
    unending: `Arcade's action list for ${toolkit} never ended after ${CATALOGUE_MAX_PAGES} pages, so it is not trusted.`,
    incomplete: (seen, total) =>
      `Arcade listed ${seen} of ${total} actions for ${toolkit}, so what this account holds there could not be read in full.`,
  })) {
    grants.push(...grantStateOf(item));
  }
  return grants;
}

/**
 * The auth provider a toolkit's connections are held under, read off the LISTING ITSELF.
 *
 * READ, NEVER DERIVED FROM THE TOOLKIT NAME. `requirements.authorization.provider_id` is the field
 * the fixture already carries beside the auth-config `id`, and it names an auth-provider
 * configuration rather than a toolkit — one Google provider serves `Gmail` and `GoogleCalendar`
 * both. Reading it is correct under BOTH readings of the field: if it did turn out to equal the
 * toolkit slug, the listing would simply say so. Comparing it to the toolkit name is correct under
 * only one, and would be invisible against every fixture in this tree, where `Github`, `Asana` and
 * `Attio` all happen to be named after themselves. There is NO FALLBACK to the toolkit name.
 *
 * ONE PAGE AND NO PAGING, which is what makes this free: every tool in a toolkit shares its auth
 * provider — that is what makes it a toolkit. `listApps` pages to the end because it is COUNTING
 * actions; this is reading a per-toolkit fact off any of them.
 *
 * IT IS THE ONLY LISTING IN THIS FILE LEFT UNPAGED, DELIBERATELY. `grantsFor` and `connectionsFor`
 * were paged because each answers ONE THING PER ROW, so a first page of theirs is a partial answer
 * wearing a whole one's clothes. This answers one thing for the WHOLE TOOLKIT, so a further page
 * can only repeat what the first already said — and the cost of paging it would be paid on every
 * `isConnected`, `accountName` and `revoke`. A toolkit whose later pages disagreed with its first
 * would be resolved here rather than unanswered; that is the known edge of this choice, and it is
 * the vendor contradicting what a toolkit is.
 *
 * AND IT GUARDS RATHER THAN ASSUMES. The DISTINCT non-null provider ids on the page are collected
 * and anything other than exactly one answers `null`, so a toolkit that disagrees with itself is
 * UNANSWERED rather than silently resolved to whichever action came first. Case is carried through
 * untouched, so two spellings of one provider count as two and are likewise unanswered; whether
 * they are the same provider is the caller's comparison, and `connectionSiblings` folds case for
 * the one caller that makes it.
 *
 * `requirements.met` IS NOT READ HERE EITHER, for `grantStateOf`'s reason: this reads a DIFFERENT
 * field of the same `requirements.authorization` object.
 */
async function authProviderOf(
  client: Arcade,
  toolkit: string,
): Promise<string | null> {
  const page = await client.tools.list({ toolkit });
  const items = sentItemsOf(page);
  if (!Array.isArray(items)) {
    throw new Error(
      `Arcade did not answer with an action list for ${toolkit}, so the auth provider its connections are held under could not be read.`,
    );
  }
  const named = new Set<string>();
  for (const item of items) {
    const authorization = record(record(item)?.requirements)?.authorization;
    const provider = textOf(record(authorization)?.provider_id);
    if (provider) named.add(provider);
  }
  return named.size === 1 ? [...named][0] : null;
}

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
    // `total_count` IS NORMALIZED HERE, and this is the only place it can be. The transport
    // (`./arcade`) must not import this file — that direction is a cycle — so it cannot reach
    // {@link reportedTotalOf}, and what it receives has to already tell "the vendor did not say"
    // apart from "the vendor said zero". Handing it the SDK's `OffsetPage` does not: that object's
    // `total_count` is `body.total_count || 0`, so `listTools` read a `0` off an answer that
    // carried no total and its `raw.length < total` cross-check could never fire. The FIELD IS
    // OMITTED when the vendor omitted it, which is what the declared `total_count?: number` means.
    listTools: async (q) => {
      const answer = await client.tools.list({
        toolkit: q.toolkit,
        limit: q.limit,
        offset: q.offset,
      });
      // Passed through unchecked: a malformed listing is the transport's sentence to write, and
      // its own `Array.isArray` guard is what writes it. THE ITEMS ARE READ OFF THE RAW BODY for
      // {@link sentItemsOf}'s reason — handing over the page's manufactured `[]` would leave that
      // guard as dead as the totals the comment above describes, and a listing that answered no
      // items at all would refresh an app's actions down to none.
      const items = sentItemsOf(answer) as unknown[];
      const total = reportedTotalOf(answer);
      return total === undefined ? { items } : { items, total_count: total };
    },
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
    accountName: async ({ account, toolkit }) => {
      // Filtered by the row's own provider, as Composio's `accountsFor(..., toolkit, ...)` is: a
      // person connected to two apps must never be shown the OTHER app's name on this app's screen.
      for (const row of await connectionsFor(
        client,
        account.vendorUserId,
        toolkit,
      )) {
        const info = row.provider_user_info as
          | { name?: unknown; login?: unknown }
          | null
          | undefined;
        const name = textOf(info?.name) ?? textOf(info?.login);
        if (name) return name;
      }
      return null;
    },
    // The mint. Stays a TOP-LEVEL member: the Composio connect flow calls it from routes.ts, so it
    // cannot move behind the nullable `authorizations` sub-surface.
    authorize: async ({ account, action }) => {
      if (!action) {
        throw new BrokerRefusalError(
          "Arcade grants per action, so an authorization needs the action it is for and none was given.",
        );
      }
      // NEVER SEND `next_uri`. THIS LOOKS LIKE A BUG AND IS A MEASUREMENT. The SDK declares the
      // field (`ToolAuthorizeParams.next_uri`), but against the live API it refuses EVERY value and
      // the mint answers `500 "error starting authorization challenge: invalid next URI"`: an app
      // page, the verifier's own origin, `cloud.arcade.dev` and a localhost address alike. Do not
      // "fix" this by passing a return address.
      //
      // `returnUrl` IS ACCEPTED AND IGNORED, for the same reason: the landing page comes from the
      // attempt row (spec D18), not from a parameter this vendor will take.
      const answer = await client.tools.authorize({
        tool_name: action,
        user_id: account.vendorUserId,
      });
      // The url is a bearer capability: it goes back to the caller and nowhere else.
      const url = answer.url;
      if (typeof url !== "string" || url === "") {
        throw new Error(
          "Arcade answered an authorization with no url to visit.",
        );
      }
      // The mint's own `ar_…` id: spec D24 binds it to the callback's `auth_id`. A mint that
      // answered none is not a success, and the refusal is here so that a null can never be
      // minted from an Arcade answer — `authorizationId` is non-null for every Arcade mint.
      const authorizationId = answer.id;
      if (typeof authorizationId !== "string" || authorizationId === "") {
        throw new Error("Arcade answered an authorization with no id.");
      }
      return { redirectUrl: url, authorizationId };
    },
    // 6.2: the connection-lifecycle trio.
    isConnected: async ({ account, toolkit }) =>
      (await connectionsFor(client, account.vendorUserId, toolkit)).length > 0,
    // Answers what was REQUESTED: true when something was found and every delete was accepted,
    // false when there was nothing. Every delete is attempted, then ANY failure throws: a partial
    // ask must not read as `false` ("nothing there") nor as a clean `true`.
    revoke: async ({ account, toolkit }) => {
      const rows = await connectionsFor(client, account.vendorUserId, toolkit);
      if (rows.length === 0) return false;
      const outcomes = await Promise.allSettled(
        rows.map((row) => deleteConnection(client, row.connection_id)),
      );
      const failed = outcomes.filter((o) => o.status === "rejected");
      if (failed.length > 0) {
        throw new Error(
          `Arcade revoke failed for ${failed.length} of ${rows.length} connections.`,
          { cause: (failed[0] as PromiseRejectedResult).reason },
        );
      }
      return true;
    },
    revokeAccount: (accountId) => deleteConnection(client, accountId),
    // 6.3: the read-only status pair. Both are DECLARED here because the seam requires them —
    // `grantsFor` is a member every broker answers, and `authorizations` is the sub-surface Arcade
    // alone runs, so a null here would say Arcade mints nothing to poll, which is false. The
    // bodies are 6.3's. `status` must narrow to `{ status, userId, scopes }` and nothing else: the
    // raw `auth.status` response carries `context.token`, a live provider access token, plus the
    // person's full profile.
    grantsFor: ({ account, toolkit }) =>
      grantsFor(client, account.vendorUserId, toolkit),
    // Read off the listing's own `requirements.authorization.provider_id`, never derived from the
    // toolkit name and never falling back to it. See `authProviderOf` above.
    authProviderOf: (toolkit) => authProviderOf(client, toolkit),
    authorizations: {
      /**
       * Where one minted authorization has got to — THREE FIELDS READ OUT AND THE RESPONSE OBJECT
       * DROPPED HERE, inside the adapter, so nothing outside this file ever holds it.
       *
       * THIS DELIBERATELY INVERTS THIS CODEBASE'S CARRY-THE-VENDOR-ERROR-AS-`cause` CONVENTION.
       * That convention is right everywhere else: a vendor's own words are what a maintainer needs
       * when a call fails. It is wrong here, because `auth.status` answers with `context.token` — a
       * LIVE, WORKING provider access token for the person who just consented — and their full
       * `user_info` profile beside it, while `url` is a bearer capability of its own. A status
       * response LOOKS LIKE METADATA, which is exactly how the throwaway harness that proved this
       * flow came to write the token to a file on its first run.
       *
       * So the protection is the RETURN TYPE and not a comment asking the next person to remember:
       * what is not returned cannot be logged, attached as a `cause`, or written into an audit
       * payload by code that never sees it. Do not widen this, and do not add `url`.
       */
      status: async (id) => {
        const answer = await client.auth.status({ id });
        const scopes = answer.scopes;
        return {
          status: textOf(answer.status) ?? "unknown",
          userId: textOf(answer.user_id) ?? null,
          scopes: Array.isArray(scopes)
            ? scopes.filter((s): s is string => typeof s === "string")
            : [],
        };
      },
      // `handle` is opaque to the seam; `flow_id` is Arcade's word for it and stops in this file.
      // A `user_mismatch` answer is an ANSWER, so it surfaces as `{ mismatch: true }`; any other
      // failure is an outage or a bug and is rethrown untouched.
      confirmReturn: async ({ handle, vendorUserId }) => {
        try {
          const answer = await client.auth.confirmUser({
            flow_id: handle,
            user_id: vendorUserId,
          });
          return { authorizationId: answer.auth_id };
        } catch (error) {
          if (normalizeArcadeError(error)?.name === "user_mismatch") {
            return { mismatch: true };
          }
          throw error;
        }
      },
    },
  };
  return { actions, broker };
}
