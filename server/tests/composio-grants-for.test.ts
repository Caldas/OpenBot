import { describe, expect, test } from "bun:test";
import type {
  AuthorizationFlow,
  ConnectedAppBroker,
  GrantState,
} from "../src/plugins/broker";
import {
  type ComposioVendor,
  buildComposioClient,
} from "../src/plugins/composio-adapter";

/**
 * `grantsFor` through Composio, whose answer is DEGENERATE AND IS STILL AN ANSWER.
 *
 * The seam asks one question both providers answer: what does this account hold at this app.
 * Composio's auth config fixes the scope set when it is created, so every action in a toolkit
 * shares one state and one scope list — and reporting that state once per action is the honest
 * rendering of a toolkit-wide grant, not a stub standing in for a missing implementation. The
 * assertions below are therefore about SAMENESS as much as about the state: one entry per action,
 * the same verdict on each, and the scopes read off this deployment's own config rather than
 * invented per action.
 *
 * This file is named in `server/tsconfig.json`'s `include`, because the last describe is a TYPE
 * test and a `@ts-expect-error` inside an unchecked directory asserts nothing at all.
 */

/** A vendor method nothing in a given test should reach, which says so rather than answering. */
const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`${what} should not have been called in this test.`);
};

/** The person every fixture here asks about. */
const ACCOUNT = {
  holder: "person",
  userId: "user_1",
  vendorUserId: "user_1",
} as const;

/**
 * A vendor answering the three listings `grantsFor` reads, and refusing everything else.
 *
 * The three are the whole of the implementation's reach: whether this person holds an account for
 * the app, which of this deployment's own auth configs stand for it (and what scopes they carry),
 * and which actions the app publishes. A fourth call is a change in what the method does, and it
 * names itself here rather than passing.
 */
function vendorWith(parts: {
  accounts: { id?: unknown; data?: unknown }[];
  configs: {
    id?: unknown;
    name?: unknown;
    status?: unknown;
    scopes?: unknown;
  }[];
  actions: { slug: string }[];
}): ComposioVendor {
  return {
    tools: {
      list: async () => ({ items: parts.actions, next_cursor: null }),
      getRawComposioToolBySlug: refuse("tools.getRawComposioToolBySlug"),
      execute: refuse("tools.execute"),
    },
    toolkits: {
      list: refuse("toolkits.list"),
      retrieve: refuse("toolkits.retrieve"),
    },
    authConfigs: {
      list: async () => ({ items: parts.configs, nextCursor: null }),
      create: refuse("authConfigs.create"),
      delete: refuse("authConfigs.delete"),
    },
    connectedAccounts: {
      list: async () => ({ items: parts.accounts, nextCursor: null }),
      link: refuse("connectedAccounts.link"),
      create: refuse("connectedAccounts.create"),
      delete: refuse("connectedAccounts.delete"),
    },
  };
}

describe("Composio's grantsFor", () => {
  test("answers one state per action, the same one for each, carrying the config's scopes", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [{ id: "ca_1" }],
        configs: [
          {
            id: "ac_1",
            name: "gmail (OpenBot)",
            status: "ENABLED",
            scopes: ["gmail.readonly", "gmail.send"],
          },
        ],
        actions: [
          { slug: "GMAIL_FETCH_EMAILS" },
          { slug: "GMAIL_SEND_EMAIL" },
          { slug: "GMAIL_CREATE_LABEL" },
        ],
      }),
    );

    const grants = await broker.grantsFor({
      toolkit: "gmail",
      account: ACCOUNT,
    });

    expect(grants).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "authorized",
        scopes: ["gmail.readonly", "gmail.send"],
      },
      {
        action: "GMAIL_SEND_EMAIL",
        state: "authorized",
        scopes: ["gmail.readonly", "gmail.send"],
      },
      {
        action: "GMAIL_CREATE_LABEL",
        state: "authorized",
        scopes: ["gmail.readonly", "gmail.send"],
      },
    ]);
    // The sameness is the claim, asserted on its own so that a per-action answer invented here
    // fails even if each entry happens to be well-formed.
    expect(new Set(grants.map((grant) => grant.state))).toEqual(
      new Set(["authorized"]),
    );
  });

  test("answers needs-consent for each action where this person has connected nothing", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [],
        configs: [
          {
            id: "ac_1",
            name: "gmail (OpenBot)",
            status: "ENABLED",
            scopes: ["gmail.readonly"],
          },
        ],
        actions: [{ slug: "GMAIL_FETCH_EMAILS" }, { slug: "GMAIL_SEND_EMAIL" }],
      }),
    );

    const grants = await broker.grantsFor({
      toolkit: "gmail",
      account: ACCOUNT,
    });

    expect(grants).toEqual([
      {
        action: "GMAIL_FETCH_EMAILS",
        state: "needs-consent",
        scopes: ["gmail.readonly"],
      },
      {
        action: "GMAIL_SEND_EMAIL",
        state: "needs-consent",
        scopes: ["gmail.readonly"],
      },
    ]);
  });

  /**
   * A config publishing no scope set is an empty list rather than a refusal, because this method
   * REPORTS rather than acts: Composio publishes no scopes for a key-scheme config at all, and an
   * app whose grant cannot be described scope by scope is still an app this person is connected to.
   */
  test("carries an empty scope list where the config publishes none", async () => {
    const { broker } = buildComposioClient(
      vendorWith({
        accounts: [{ id: "ca_1" }],
        configs: [
          { id: "ac_1", name: "firecrawl (OpenBot)", status: "ENABLED" },
        ],
        actions: [{ slug: "FIRECRAWL_SCRAPE" }],
      }),
    );

    expect(
      await broker.grantsFor({ toolkit: "firecrawl", account: ACCOUNT }),
    ).toEqual([
      { action: "FIRECRAWL_SCRAPE", state: "authorized", scopes: [] },
    ]);
  });
});

/**
 * `authorizations` is a DECLARED value, and Composio's declaration is `null`.
 *
 * Read with a presence test and never with a vendor name: the point of the field is that the
 * broker says what it runs, on the object it hands over.
 */
describe("Composio's authorizations", () => {
  test("declares null rather than offering a flow it does not run", () => {
    const { broker } = buildComposioClient(
      vendorWith({ accounts: [], configs: [], actions: [] }),
    );

    expect(broker.authorizations).toBeNull();
  });
});

/**
 * THE NULLABILITY IS ONLY WORTH ANYTHING IF OMITTING THE FIELD FAILS, which is a claim about the
 * type and therefore a claim only `tsc` can settle — hence this file in `server/tsconfig.json`.
 *
 * An optional-shaped capability is the exact shape that failed open at `store.ts:1631`: nine broker
 * stubs omitted `grantIsLocal`, the gate's exemption read `undefined`, and a call ran for somebody
 * who had connected nothing. The two assertions below are the two halves of that — a literal
 * missing `authorizations` must not compile, and a literal declaring it `null` must.
 */
describe("the declared sub-surface", () => {
  test("a broker literal omitting authorizations does not compile", () => {
    const members = {
      grantIsLocal: true,
      // Nothing here asks what auth provider a connection is held under.
      authProviderOf: async () => null,
      grantsFor: async (): Promise<GrantState[]> => [],
      listApps: async () => [],
      ensureAuthConfig: async () => "not-needed" as const,
      deleteAuthConfig: async () => {},
      authorize: async () => ({
        redirectUrl: "https://openbot.test/x",
        authorizationId: null,
      }),
      isConnected: async () => false,
      revoke: async () => false,
      connectionFields: async () => [],
      connectWithFields: async () => ({ accountId: "ca_1" }),
      revokeAccount: async () => {},
      accountName: async () => null,
    };

    // @ts-expect-error `authorizations` is required: a broker must SAY whether it runs a
    // correlated, pollable authorization flow, and an omission is not an answer.
    const omitted: ConnectedAppBroker = members;
    const declared: ConnectedAppBroker = { ...members, authorizations: null };

    expect(omitted.grantIsLocal).toBe(true);
    expect(declared.authorizations).toBeNull();
  });

  test("a broker that runs the flow declares the sub-surface instead", () => {
    const flow: AuthorizationFlow = {
      status: async () => ({ status: "completed", userId: null, scopes: [] }),
      confirmReturn: async () => ({ mismatch: true }),
    };

    expect(flow).not.toBeNull();
  });
});
