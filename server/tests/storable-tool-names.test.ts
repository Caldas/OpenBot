import { describe, expect, test } from "bun:test";
import {
  OFFERABLE_TOOL_NAME,
  PluginInvariantError,
  storableTools,
  toolNameFor,
} from "../src/plugins/plugin-store/model";

/**
 * THE ONE SEAM EVERY TRANSPORT'S LISTING CROSSES ON ITS WAY INTO THE DATABASE, asked the question
 * nothing used to ask it: is this a name a model can actually be offered?
 *
 * The defect that put this here was Arcade's, but the hole was general. `mcp_tools.name` is spliced
 * into `mcp__<server>__<name>` and handed to the model API, which takes `^[a-zA-Z0-9_-]+$` and
 * nothing else — and no code between the vendor's listing and that request ever looked. A dotted
 * `Gmail.ListEmails` was recorded, offered, and refused as `Invalid 'tools[47].name'`: a 400 on the
 * whole request, naming an index, mentioning neither the app nor the action nor the refresh that
 * recorded it. Whoever read that had nothing to act on.
 */
describe("a listing may not record a name the model API would refuse", () => {
  const listed = (name: string) => [{ name, description: "", inputSchema: {} }];

  test("a dotted name is refused, and the sentence names the app and the action", () => {
    expect(() =>
      storableTools("arcade-Gmail", listed("Gmail.ListEmails")),
    ).toThrow(PluginInvariantError);

    /*
     * THE TWO THINGS A READER NEEDS, checked rather than assumed: which app published it and what
     * it was called. The old failure carried neither.
     */
    try {
      storableTools("arcade-Gmail", listed("Gmail.ListEmails"));
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as Error).message).toContain("arcade-Gmail");
      expect((error as Error).message).toContain("Gmail.ListEmails");
      // And says what was NOT done, because a refused refresh leaves the held actions standing.
      expect((error as Error).message).toContain("kept");
    }
  });

  test("the names the other transports publish are untouched", () => {
    /*
     * COMPOSIO AND MCP PASS AS THEY STAND, which is what makes this guard safe to add to a live
     * deployment: the only non-alphanumeric character in any name those transports publish is `_`.
     * A guard that refused them would take every working connector down with it.
     */
    const rows = storableTools("gmail", listed("GMAIL_FETCH_EMAILS"));

    expect(rows).toMatchObject([
      { name: "GMAIL_FETCH_EMAILS", vendorName: "GMAIL_FETCH_EMAILS" },
    ]);
  });

  test("a transport that draws no distinction records the same string twice", () => {
    /*
     * ABSENCE MEANS "THE SAME NAME", AND IS RECORDED AS THE SAME NAME rather than as a null the
     * readers would each have to remember to fall back from. Every read of `vendorName` is a call
     * about to be made or a gate about to be answered; a tri-state there is a branch each one could
     * get wrong separately.
     */
    expect(storableTools("notes", listed("search"))).toMatchObject([
      { name: "search", vendorName: "search" },
    ]);
  });

  test("a transport's own spelling is kept when it gives one", () => {
    const rows = storableTools("arcade-Gmail", [
      {
        name: "ListEmails",
        vendorName: "Gmail.ListEmails",
        description: "",
        inputSchema: {},
      },
    ]);

    expect(rows).toMatchObject([
      { name: "ListEmails", vendorName: "Gmail.ListEmails" },
    ]);
  });

  test("what survives the guard is an offered name the API accepts", () => {
    /*
     * THE GUARD'S WHOLE POINT, stated as the property rather than as a list of cases. The prefix and
     * the separator are themselves made of accepted characters, so a `name` that passes is an
     * offered name that passes — and that is the implication worth pinning, because it is the one
     * the guard is relied on for.
     */
    for (const name of [
      "search",
      "GMAIL_FETCH_EMAILS",
      "ListEmails",
      "a-b_C9",
    ]) {
      const [row] = storableTools("server-id", listed(name));
      expect(OFFERABLE_TOOL_NAME.test(row!.name)).toBe(true);
      expect(toolNameFor(`server-id/${row!.name}`)).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});
