import { expect, test } from "bun:test";
import {
  AUTHORIZATION_NOTICES,
  authorizationNoticeFor,
} from "@/routes/_authed/settings/connected-accounts/index";

/**
 * The notice channel the brokered per-action verifier reports back on, decided without drawing
 * anything.
 *
 * THE SENTENCE LIVES HERE AND THE URL CARRIES ONLY A CODE, which is the whole point of the channel.
 * A message rendered from a query string is a message anybody can author on this deployment's own
 * origin: a link could be passed around carrying whatever sentence its author liked, shown in this
 * page's voice under this deployment's address. So the server chooses from a closed set of opaque
 * codes and this map is the only place one becomes words — which is also what stops a sentence
 * being maintained in two places that drift.
 *
 * A `.tsx` file because it imports a route module, which is JSX; the precedent is
 * `connected-accounts-list.test.tsx`, which exports its own rule as a function for this reason.
 */

/**
 * THE SAME CLOSED SET THE SERVER HOLDS, asserted as a set here too. The server's own suite asserts
 * `AUTHORIZATION_REFUSALS` against this same list, so a code added on one side without the other
 * turns one of the two red: a new code with no sentence would otherwise draw nothing at all.
 */
test("every reason the verifier can send has a sentence here, and no others", () => {
  expect(Object.keys(AUTHORIZATION_NOTICES)).toEqual([
    "no-broker",
    "not-supported",
    "missing-handle",
    "no-attempt",
    "vendor-unavailable",
    "not-your-authorization",
    "not-finished",
    "authorization-failed",
    "context-changed",
    "not-recorded",
  ]);
});

test("each code reads as its own sentence, not as one generic apology", () => {
  const sentences = Object.values(AUTHORIZATION_NOTICES);
  expect(new Set(sentences).size).toBe(sentences.length);
  for (const sentence of sentences) {
    // Long enough to say what happened and what to do about it, rather than an apology.
    expect(sentence.length).toBeGreaterThan(60);
  }
});

test("a code is turned into the words for it", () => {
  expect(authorizationNoticeFor("no-attempt")).toBe(
    AUTHORIZATION_NOTICES["no-attempt"],
  );
});

/**
 * AND A CODE THIS BUILD DOES NOT KNOW DRAWS NOTHING, deliberately. Such a code is either somebody
 * probing the parameter or a deployment mid-upgrade; a generic "something went wrong" for both
 * would tell a person nothing and invite them to keep trying.
 */
test("an unrecognised or absent code draws nothing", () => {
  expect(authorizationNoticeFor("something-somebody-made-up")).toBeNull();
  expect(authorizationNoticeFor("")).toBeNull();
  expect(authorizationNoticeFor(undefined)).toBeNull();
});

/** The sentence never travels in the URL, so nothing in the map may be read out of one. */
test("the notices are not reachable from the search parameter's own value", () => {
  expect(
    authorizationNoticeFor("That account could not be connected."),
  ).toBeNull();
});
