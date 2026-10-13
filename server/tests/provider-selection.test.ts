import { describe, expect, test } from "bun:test";
import {
  activeProvider,
  assertActivatable,
  BrokerRefusalError,
  brokerSentence,
} from "../src/plugins/broker";
import { selectProviderWiring } from "../src/plugins/provider-wiring";

/**
 * Which broker is active, decided from configuration alone: no network, no database.
 *
 * Both keys set is legal and expected, since ending an account at the old vendor needs its key.
 */
describe("activeProvider", () => {
  test("exactly one key set selects that provider", () => {
    expect(activeProvider({ composioApiKey: "c" })).toBe("composio");
    expect(activeProvider({ arcadeApiKey: "a" })).toBe("arcade");
  });

  test("both keys set: brokerProvider decides", () => {
    const keys = { composioApiKey: "c", arcadeApiKey: "a" };
    expect(activeProvider({ ...keys, brokerProvider: "composio" })).toBe(
      "composio",
    );
    expect(activeProvider({ ...keys, brokerProvider: "arcade" })).toBe(
      "arcade",
    );
  });

  test("both keys set with brokerProvider unset selects nothing", () => {
    expect(activeProvider({ composioApiKey: "c", arcadeApiKey: "a" })).toBe(
      null,
    );
  });

  test("neither key set selects nothing", () => {
    expect(activeProvider({})).toBe(null);
    expect(activeProvider({ brokerProvider: "arcade" })).toBe(null);
  });

  test("a brokerProvider whose key is unset is refused, not selected", () => {
    expect(
      activeProvider({ composioApiKey: "c", brokerProvider: "arcade" }),
    ).toBe(null);
    expect(
      activeProvider({ arcadeApiKey: "a", brokerProvider: "composio" }),
    ).toBe(null);
  });
});

/**
 * The activation refusal keys on ROWS, never on keys: no database, no key, no vendor package.
 */
describe("assertActivatable", () => {
  test("rows for the other provider refuse activation, naming the sunset flow", () => {
    let caught: unknown;
    try {
      assertActivatable("arcade", 3);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BrokerRefusalError);
    const sentence = brokerSentence(caught);
    expect(sentence).toContain("sunset");
    expect(sentence).toContain("Composio");
  });

  test("zero rows for the other provider lets activation proceed", () => {
    expect(() => assertActivatable("arcade", 0)).not.toThrow();
    expect(() => assertActivatable("composio", 0)).not.toThrow();
  });

  test("one row for the other provider refuses, in the other direction and in the singular", () => {
    let caught: unknown;
    try {
      assertActivatable("composio", 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BrokerRefusalError);
    const sentence = brokerSentence(caught);
    expect(sentence).toContain("Composio cannot be activated");
    expect(sentence).toContain("1 brokered connection still belongs to Arcade");
    expect(sentence).toContain("sunset");
  });
});

/**
 * The entrypoint's decision, extracted so no test boots the server: which transport client is
 * installed, which broker is passed on, and what happens to a named provider whose key is unset.
 * Fake factories stand in for the vendor constructors, so nothing here can make a request.
 */
describe("selectProviderWiring", () => {
  function factories() {
    const calls: string[] = [];
    const composioActions = { tag: "composio-actions" } as never;
    const arcadeActions = { tag: "arcade-actions" } as never;
    const composioBroker = { tag: "composio-broker" } as never;
    const arcadeBroker = { tag: "arcade-broker" } as never;
    return {
      calls,
      composioActions,
      arcadeActions,
      composioBroker,
      arcadeBroker,
      create: {
        composio: (key: string) => {
          calls.push(`composio:${key.length}`);
          return { actions: composioActions, broker: composioBroker };
        },
        arcade: (key: string) => {
          calls.push(`arcade:${key.length}`);
          return { actions: arcadeActions, broker: arcadeBroker };
        },
      },
    };
  }

  test("only the Arcade key installs the Arcade client and leaves the Composio seam null", () => {
    const f = factories();
    const wiring = selectProviderWiring({ arcadeApiKey: "a" }, f.create);
    expect(wiring.provider).toBe("arcade");
    expect(wiring.install.arcade).toBe(f.arcadeActions);
    expect(wiring.install.composio).toBeNull();
    expect(wiring.broker).toBe(f.arcadeBroker);
    expect(f.calls).toEqual(["arcade:1"]);
  });

  test("only the Composio key is today's behaviour: its client, its broker, Arcade null", () => {
    const f = factories();
    const wiring = selectProviderWiring({ composioApiKey: "c" }, f.create);
    expect(wiring.provider).toBe("composio");
    expect(wiring.install.composio).toBe(f.composioActions);
    expect(wiring.install.arcade).toBeNull();
    expect(wiring.broker).toBe(f.composioBroker);
    expect(f.calls).toEqual(["composio:1"]);
  });

  test("both keys with nothing named is refused, not degraded to no broker", () => {
    const f = factories();
    expect(() =>
      selectProviderWiring(
        { composioApiKey: "c", arcadeApiKey: "a" },
        f.create,
      ),
    ).toThrow(
      /COMPOSIO_API_KEY.*ARCADE_API_KEY.*OPENBOT_BROKER_PROVIDER|OPENBOT_BROKER_PROVIDER.*COMPOSIO_API_KEY.*ARCADE_API_KEY/s,
    );
    expect(f.calls).toEqual([]);
  });

  test("the refusal for two keys names neither key's value", () => {
    const f = factories();
    let caught: unknown;
    try {
      selectProviderWiring(
        { composioApiKey: "composio-secret", arcadeApiKey: "arcade-secret" },
        f.create,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const sentence = (caught as Error).message;
    expect(sentence).not.toContain("composio-secret");
    expect(sentence).not.toContain("arcade-secret");
    expect(sentence).toContain("OPENBOT_BROKER_PROVIDER");
  });

  test("both keys with a provider named installs only the named one", () => {
    const f = factories();
    const wiring = selectProviderWiring(
      { composioApiKey: "c", arcadeApiKey: "a", brokerProvider: "arcade" },
      f.create,
    );
    expect(wiring.provider).toBe("arcade");
    expect(wiring.install.composio).toBeNull();
    expect(wiring.install.arcade).toBe(f.arcadeActions);
    expect(f.calls).toEqual(["arcade:1"]);
  });

  test("no keys at all is a legal no-broker deployment", () => {
    const f = factories();
    const wiring = selectProviderWiring({}, f.create);
    expect(wiring.provider).toBeNull();
    expect(wiring.broker).toBeNull();
    expect(wiring.install).toEqual({ composio: null, arcade: null });
  });

  test("a named provider whose key is unset is surfaced, not treated as no broker", () => {
    const f = factories();
    expect(() =>
      selectProviderWiring(
        { composioApiKey: "c", brokerProvider: "arcade" },
        f.create,
      ),
    ).toThrow(/OPENBOT_BROKER_PROVIDER=arcade.*ARCADE_API_KEY/);
    expect(() =>
      selectProviderWiring(
        { arcadeApiKey: "a", brokerProvider: "composio" },
        f.create,
      ),
    ).toThrow(/OPENBOT_BROKER_PROVIDER=composio.*COMPOSIO_API_KEY/);
    expect(() =>
      selectProviderWiring({ brokerProvider: "arcade" }, f.create),
    ).toThrow(/ARCADE_API_KEY/);
    expect(f.calls).toEqual([]);
  });
});
