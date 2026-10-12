import { expect, test } from "bun:test";
import fixture from "../../server/tests/fixtures/arcade-catalogue.json";
import {
  consentCopy,
  type ConsentAction,
} from "@/lib/plugins/enablement-notes";

/**
 * The copy shown before redirecting somebody to a consent screen (spec D30). The action list is
 * DERIVED by grouping on `scopes`; the fixture is evidence and is never appended to, so shapes it
 * does not carry (a shared scope across actions) are constructed inline.
 */

type FixtureTool = {
  qualified_name: string;
  toolkit: { name: string };
  requirements?: { authorization?: { oauth2?: { scopes?: string[] } } };
};

function fromFixture(toolkit: string): ConsentAction[] {
  return (Object.values(fixture.tools) as FixtureTool[])
    .filter((tool) => tool.toolkit.name === toolkit)
    .map((tool) => ({
      name: tool.qualified_name,
      scopes: tool.requirements?.authorization?.oauth2?.scopes ?? [],
    }));
}

const gmail: ConsentAction[] = [
  { name: "Gmail.ListEmails", scopes: ["gmail.readonly"] },
  { name: "Gmail.ListThreads", scopes: ["gmail.readonly"] },
  { name: "Gmail.GetThread", scopes: ["gmail.readonly"] },
  { name: "Gmail.SendEmail", scopes: ["gmail.send"] },
];

test("scoped: names the permission and lists the actions grouped on that scope", () => {
  const copy = consentCopy("Gmail.ListEmails", gmail);
  expect(copy.scopes).toEqual(["gmail.readonly"]);
  expect(copy.alsoEnables).toEqual(["Gmail.GetThread", "Gmail.ListThreads"]);
  expect(copy.sentence).toContain("gmail.readonly");
  expect(copy.sentence).toContain("also enables");
  expect(copy.sentence).toContain("Gmail.GetThread, Gmail.ListThreads");
  expect(copy.sentence).not.toContain("Gmail.SendEmail");
  // The list follows the data: change a scope and the list changes with it.
  const moved = gmail.map((a) =>
    a.name === "Gmail.GetThread" ? { ...a, scopes: ["gmail.modify"] } : a,
  );
  expect(consentCopy("Gmail.ListEmails", moved).alsoEnables).toEqual([
    "Gmail.ListThreads",
  ]);
});

test("scoped, from the fixture: a lone scope set lists no sibling", () => {
  const asana = fromFixture("Asana");
  const copy = consentCopy(asana[0]!.name, asana);
  expect(copy.scopes).toEqual(["default"]);
  expect(copy.alsoEnables).toEqual([]);
  expect(copy.sentence).toContain("No other action requires it.");
});

test("unscoped: all-or-nothing, with the count derived", () => {
  const apollo = fromFixture("Apollo");
  expect(consentCopy(apollo[0]!.name, apollo).sentence).toContain(
    "approving this approves its single action",
  );
  const forty3 = Array.from({ length: 43 }, (_, i) => ({
    name: `Github.Action${i}`,
    scopes: [],
  }));
  expect(consentCopy("Github.Action0", forty3).sentence).toContain(
    "This app cannot separate permissions; approving this approves all 43.",
  );
  expect(consentCopy("Github.Action0", forty3.slice(0, 7)).sentence).toContain(
    "approves all 7.",
  );
});

test("an unscoped action in a scoped app is not worded as a permission", () => {
  const airtable = fromFixture("AirtableApi");
  const bare = airtable.find((a) => a.scopes.length === 0)!;
  const copy = consentCopy(bare.name, airtable);
  expect(copy.scopes).toEqual([]);
  expect(copy.sentence).toContain("requests no permission of its own");
});

test("no copy promises confinement", () => {
  const shapes = [
    consentCopy("Gmail.ListEmails", gmail),
    consentCopy("Gmail.SendEmail", gmail),
    consentCopy("Apollo.X", [{ name: "Apollo.X", scopes: [] }]),
    consentCopy(
      "G.A",
      Array.from({ length: 43 }, (_, i) => ({ name: `G.A${i}`, scopes: [] })),
    ),
    consentCopy("Missing", gmail),
  ];
  for (const shape of shapes) {
    expect(shape.sentence).not.toMatch(
      /confin|only (the|that|this)|just (the|that|this)|limited to|isolat|least.privilege|restricted to|nothing else/i,
    );
  }
});
