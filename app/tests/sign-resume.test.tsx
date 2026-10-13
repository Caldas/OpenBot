import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
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
const realAuthClient = { ...(await import("@/lib/auth/client")) };
let signInSpy: SignInSpy = async () => {};
mock.module("@/lib/auth/client", () => ({
  providerName: () => "Google",
  signInWith: (...args: Parameters<SignInSpy>) => signInSpy(...args),
  signInWithEmailDomain: async () => {},
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

test("the sign-in starter gets the resume URL as its callbackURL", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.providers(), {
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });
  const asked: string[] = [];
  signInSpy = async (_provider, _start, callbackURL) => {
    asked.push(callbackURL ?? "");
  };

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
  const user = userEvent.setup({ document: view.container.ownerDocument });
  await user.click(await view.findByText(/Continue with Google/));
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(asked[0]).toBe(
    `${window.location.origin}/api/plugins/arcade/verify?flow_id=h1`,
  );
});

/*
 * THE RETURN LEG HAS TO ACTUALLY ARRIVE.
 *
 * The verifier is an API path, not a route in this app's tree. A redirect the router is left to
 * handle inside the app therefore matches nothing, and `__root.tsx`'s `notFoundComponent` sends an
 * unknown address home — so somebody who was asked to sign in half-way through connecting an app
 * signs in and lands on the home screen, with the authorization they started left behind and
 * nothing said about it. Only a document navigation reaches the verifier at all, which is why this
 * asserts on WHERE THE BROWSER ENDS UP rather than on the shape of the thrown redirect.
 */
test("a signed-in arrival with a handle lands on the verifier, not back on the home screen", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.currentUser(), { id: "u1" });
  queryClient.setQueryData(authKeys.providers(), {
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });

  // Leaving the single-page app is an assignment to `window.location`; record it rather than ask
  // happy-dom to fetch a path no server is listening on in this test.
  const left: string[] = [];
  const realLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      origin: realLocation.origin,
      get href() {
        return left.at(-1) ?? `${realLocation.origin}/sign?flow_id=h1`;
      },
      set href(url: string) {
        left.push(url);
      },
      replace: (url: string) => left.push(url),
      assign: (url: string) => left.push(url),
    },
  });

  const root = createRootRoute({
    component: () => <Outlet />,
    // Mirrors app/src/routes/__root.tsx: an address this build does not know goes home.
    notFoundComponent: () => <Navigate replace to="/" />,
  });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <p>home</p>,
  });
  const sign = Route.update({
    id: "/sign",
    path: "/sign",
    getParentRoute: () => root,
  } as never);
  // The route tree is assembled by hand, so its types cannot describe it.
  const router = createRouter({
    routeTree: root.addChildren([home, sign]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/sign?flow_id=h1"] }),
  } as never) as never;

  try {
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    // Where the browser is: the document it was sent to, or the in-app location when it was never
    // sent anywhere.
    const destination = () =>
      left.at(-1) ??
      (router as unknown as { state: { location: { href: string } } }).state
        .location.href;
    await waitFor(() => expect(destination()).not.toContain("/sign"));
    expect(destination()).toBe("/api/plugins/arcade/verify?flow_id=h1");
    // And it got there by leaving the app, which is the only way the verifier is ever requested.
    expect(left).toEqual(["/api/plugins/arcade/verify?flow_id=h1"]);
  } finally {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  }
});
