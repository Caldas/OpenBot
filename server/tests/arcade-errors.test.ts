import { afterEach, describe, expect, test } from "bun:test";
import {
  callTool,
  isAuthorizationRequired,
  listTools,
  useArcadeClient,
  type ArcadeFailure,
} from "../src/plugins/arcade";

afterEach(() => useArcadeClient(null));

const connection = { url: "arcade://Gmail", actorId: "u1" };
const URL_IN_BODY = "https://github.com/login/oauth/authorize?state=SECRET";

function failing(failure: unknown) {
  useArcadeClient({
    listTools: async () => {
      throw new Error("not listing");
    },
    execute: async () => {
      throw failure;
    },
  });
}

describe("isAuthorizationRequired", () => {
  test("keys on the body's error name", () => {
    expect(
      isAuthorizationRequired({
        status: 403,
        name: "tool_authorization_required",
        message: "authorization required",
      }),
    ).toBe(true);
  });

  test("the name alone is enough: it never reads the status", () => {
    expect(
      isAuthorizationRequired({
        status: undefined,
        name: "tool_authorization_required",
        message: undefined,
      }),
    ).toBe(true);
  });

  test("a 403 is not an authorization prompt", () => {
    for (const name of ["permission_denied", undefined, "rate_limited"]) {
      expect(isAuthorizationRequired({ status: 403, name, message: "x" })).toBe(
        false,
      );
    }
  });
});

describe("callTool failures", () => {
  test("an authorization-required failure names the action callTool was given", async () => {
    failing({
      status: 403,
      name: "tool_authorization_required",
      message: `authorization required ${URL_IN_BODY}`,
    } satisfies ArcadeFailure);
    const result = await callTool(connection, "Gmail.SendEmail", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Gmail.SendEmail has not been authorized on this account yet. Authorize it in Settings → Connected accounts and ask again.",
    );
    expect(result.text).not.toContain("http");
    expect(result.text).not.toContain("SECRET");
  });

  test("the action comes from the call site, not from anything on the error", async () => {
    failing({
      status: 403,
      name: "tool_authorization_required",
      message: "m",
      toolName: "Other.Thing",
    });
    const result = await callTool(connection, "Slack.Post", {});
    expect(result.text.startsWith("Slack.Post has not been authorized")).toBe(
      true,
    );
  });

  test("permission_denied at 403 is NOT an authorize prompt", async () => {
    failing({ status: 403, name: "permission_denied", message: "key revoked" });
    const result = await callTool(connection, "Gmail.SendEmail", {});
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("has not been authorized");
    expect(result.text).not.toContain("Connected accounts");
    expect(result.text).not.toContain("http");
  });

  test("a throw that is not an ArcadeFailure is handled", async () => {
    for (const thrown of [new Error("boom"), "string", null, undefined, 42]) {
      failing(thrown);
      const result = await callTool(connection, "Gmail.SendEmail", {});
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain("has not been authorized");
    }
  });
});

describe("listTools failures", () => {
  test("a vendor error on the listing path does not leak the vendor's message", async () => {
    const vendor = new Error(
      '403 {"name":"permission_denied","message":"LEAKME key sk-123"}',
    );
    useArcadeClient({
      listTools: async () => {
        throw vendor;
      },
      execute: async () => {
        throw new Error("no");
      },
    });
    const error = await listTools(connection).then(
      () => null,
      (e: Error) => e,
    );
    expect(error).not.toBeNull();
    expect(error!.message).not.toContain("LEAKME");
    expect(error!.message).not.toContain("sk-123");
    expect(error!.message).toContain("Gmail");
    expect(error!.cause).toBe(vendor);
  });
});

function answering(answer: unknown) {
  useArcadeClient({
    listTools: async () => {
      throw new Error("not listing");
    },
    execute: async () => answer as never,
  });
}

describe("callTool successes", () => {
  test("a 200 carrying an authorization envelope leaks neither the url nor the token", async () => {
    answering({
      success: true,
      output: {
        value: { ok: 1 },
        authorization: {
          url: "https://example.test/auth?state=SECRET",
          context: { token: "tok-LEAKME" },
        },
      },
    });
    const result = await callTool(connection, "Gmail.SendEmail", {});
    expect(result.text).not.toContain("http");
    expect(result.text).not.toContain("SECRET");
    expect(result.text).not.toContain("LEAKME");
    expect(result.text).toBe(
      "Gmail.SendEmail has not been authorized on this account yet. Authorize it in Settings → Connected accounts and ask again.",
    );
    expect(result.isError).toBe(true);
  });

  test("an Arcade-reported failure is an error, in this deployment's words", async () => {
    answering({ success: false, output: { error: { message: "LEAKME" } } });
    const result = await callTool(connection, "Gmail.SendEmail", {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Arcade could not run Gmail.SendEmail.");
    expect(result.text).not.toContain("LEAKME");
  });

  test("a plain success returns output.value and nothing else from the envelope", async () => {
    answering({
      success: true,
      execution_id: "exec-LEAKME",
      duration: 12.5,
      output: { value: { rows: [1, 2] } },
    });
    const result = await callTool(connection, "Gmail.SendEmail", {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe(JSON.stringify({ rows: [1, 2] }, null, 2));
    expect(result.text).not.toContain("execution_id");
    expect(result.text).not.toContain("exec-LEAKME");
    expect(result.text).not.toContain("duration");
  });
});
