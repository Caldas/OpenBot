import { describe, expect, test } from "bun:test";
import {
  activeProvider,
  assertActivatable,
  BrokerRefusalError,
  brokerSentence,
} from "../src/plugins/broker";

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

  test("both keys being set, on its own, does not trigger the refusal", () => {
    const keys = { composioApiKey: "c", arcadeApiKey: "a" };
    expect(activeProvider({ ...keys, brokerProvider: "arcade" })).toBe(
      "arcade",
    );
    expect(() => assertActivatable("arcade", 0)).not.toThrow();
  });
});
