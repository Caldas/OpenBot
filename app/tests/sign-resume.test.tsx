import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";
import { resumeUrlFor } from "@/lib/auth/resume";

/*
 * The Better Auth client is replaced at the module boundary: its fetch is captured when it is built,
 * so a test cannot intercept the request. What this pins is what the screen hands the starter.
 */
type SignInSpy = (
  provider: string,
  start: unknown,
  callbackURL?: string,
) => Promise<void>;
type DomainSignInSpy = (
  email: string,
  start: unknown,
  callbackURL?: string,
) => Promise<void>;
const realAuthClient = { ...(await import("@/lib/auth/client")) };
let signInSpy: SignInSpy = async () => {};
let domainSignInSpy: DomainSignInSpy = async () => {};
/*
 * BOTH LEGS ARE SPIED, AND NEITHER IS A NO-OP. Replacing the module is how the screen is tested at
 * all, but a replacement nobody asserts against tests nothing: `signInWithEmailDomain` stood here
 * as `async () => {}` while the SSO form's callbackURL went unpinned, so the screen could stop
 * passing the resume URL and this file stayed green. What the module boundary cannot see — the
 * real client dropping a callbackURL it was handed — is pinned in `auth-client.test.ts`, which
 * drives the real functions through their injectable starter. The two together cover the handoff.
 */
mock.module("@/lib/auth/client", () => ({
  providerName: () => "Google",
  signInWith: (...args: Parameters<SignInSpy>) => signInSpy(...args),
  signInWithEmailDomain: (...args: Parameters<DomainSignInSpy>) =>
    domainSignInSpy(...args),
}));
const { Route } = await import("@/routes/sign");

beforeAll(() => {
  GlobalRegistrator.register();
  // happy-dom starts at about:blank, whose origin is "null": nothing to build a callback URL on.
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL("http://localhost:3010/");
});
afterEach(() => {
  cleanup();
});
afterAll(() => {
  // Module mocks are process-wide in bun: hand the real client back to whatever runs next.
  mock.module("@/lib/auth/client", () => realAuthClient);
  GlobalRegistrator.unregister();
});

/*
 * THE HANDLE IS A VALUE, NEVER A DESTINATION: it is encoded into a path this code builds on this
 * origin, so what arrives in a URL cannot decide where the browser goes.
 */
test("resumeUrlFor puts an encoded handle on the verifier, and is the origin without one", () => {
  expect(resumeUrlFor("https://app.example", "a b&c/../d")).toBe(
    "https://app.example/api/plugins/arcade/verify?flow_id=a%20b%26c%2F..%2Fd",
  );
  expect(resumeUrlFor("https://app.example", undefined)).toBe(
    "https://app.example",
  );
  expect(resumeUrlFor("https://app.example", "")).toBe("https://app.example");
  // A hostile handle stays a value on this origin.
  const hostile = resumeUrlFor("https://app.example", "https://evil.test/");
  expect(new URL(hostile).origin).toBe("https://app.example");
  // Length-capped.
  expect(
    resumeUrlFor("https://app.example", "x".repeat(5000)).length,
  ).toBeLessThan(600);
});

test("validateSearch keeps a string flow_id, omits the key otherwise", () => {
  const validate = Route.options.validateSearch as (s: unknown) => object;
  expect(validate({ flow_id: "abc" })).toEqual({ flow_id: "abc" });
  expect(validate({ flow_id: 42 })).toEqual({});
  expect("flow_id" in validate({ flow_id: ["a"] })).toBe(false);
  expect("flow_id" in validate({})).toBe(false);
});

function signedInContext() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.currentUser(), { id: "u1" });
  return { queryClient };
}

async function redirectFrom(search: { flow_id?: string }) {
  const beforeLoad = Route.options.beforeLoad as (a: unknown) => Promise<void>;
  try {
    await beforeLoad({ context: signedInContext(), search });
  } catch (thrown) {
    return thrown as { options: { to?: string; href?: string } };
  }
  throw new Error("expected a redirect");
}

test("a signed-in arrival with a handle goes to the verifier, without one to /", async () => {
  const withHandle = await redirectFrom({ flow_id: "f 1" });
  expect(withHandle.options.href).toBe(
    "/api/plugins/arcade/verify?flow_id=f%201",
  );
  const without = await redirectFrom({});
  expect(without.options.to).toBe("/");
  expect(without.options.href).toBeUndefined();
});

/** The sign screen on `/sign?flow_id=h1`, with whichever ways in the deployment offers. */
function renderSignScreen(options: {
  providers: string[];
  sso: boolean;
  ssoRequired: boolean;
}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.providers(), options);

  queryClient.setQueryData(authKeys.currentUser(), null);
  const root = createRootRoute();
  const sign = Route.update({
    id: "/sign",
    path: "/sign",
    getParentRoute: () => root,
  } as never);
  // The route tree is assembled by hand, so its types cannot describe it.
  const router = createRouter({
    routeTree: root.addChildren([sign]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/sign?flow_id=h1"] }),
  } as never) as never;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

/** Where a press on this screen has to send the browser back to, with `?flow_id=h1` carried in. */
const RESUME_URL = "/api/plugins/arcade/verify?flow_id=h1";

test("the sign-in starter gets the resume URL as its callbackURL", async () => {
  const asked: string[] = [];
  signInSpy = async (_provider, _start, callbackURL) => {
    asked.push(callbackURL ?? "");
  };

  const { view, user } = renderSignScreen({
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });
  await user.click(await view.findByText(/Continue with Google/));
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(asked[0]).toBe(`${window.location.origin}${RESUME_URL}`);
});

/**
 * The company-account way in resumes too, and it was the leg nothing watched.
 *
 * A deployment whose people arrive through their own IdP has no provider buttons to press, so the
 * form below them IS the sign-in for everybody there. Leaving its callbackURL unpinned meant the
 * resume could be dropped for exactly those deployments and every test stayed green.
 */
test("the company-account form gets the resume URL as its callbackURL", async () => {
  const asked: string[] = [];
  domainSignInSpy = async (_email, _start, callbackURL) => {
    asked.push(callbackURL ?? "");
  };

  const { view, user } = renderSignScreen({
    providers: [],
    sso: true,
    ssoRequired: false,
  });
  await user.type(
    await view.findByPlaceholderText("you@company.com"),
    "someone@company.com",
  );
  await user.click(await view.findByText(/Continue with your company account/));
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(asked[0]).toBe(`${window.location.origin}${RESUME_URL}`);
});
