# Arcade

Arcade is a broker, the same kind of thing Composio is: it holds people's accounts at other apps —
Gmail, Google Calendar, GitHub, Asana and more — and publishes each app's actions as tools this
deployment can call on somebody's behalf. A Bot with a brokered action granted reaches the app **as
the person asking**, so two people asking the same question get the answers their own accounts can
see. Where Arcade differs from Composio is the part an operator has to set up: **an Arcade project
needs an OAuth app of your own for every provider, and one manual step in Arcade's dashboard.** This
page is about those, and about what to tell somebody when a connection looks wrong.

Read [Composio](composio.md) first if you have not: what a broker is, what Personal and Shared mean,
the approval rules and the audit trail are the same here and are not repeated.

Some things on this page are stated as **unproven**, and the last section lists them. Everything
else marked _measured_ was observed against a live Arcade project.

## Who sets what, and where

Setting it up takes three hands, and none of them can do another's:

| Who              | Does                                                         | Where                                                             |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Whoever deploys  | Sets `ARCADE_API_KEY`                                        | The deployment's environment. There is no screen for it           |
| Whoever deploys  | Sets `OPENBOT_BROKER_PROVIDER`, only where both keys are set | The deployment's environment                                      |
| Whoever deploys  | Registers an OAuth app per provider, and sets the verifier   | Arcade's dashboard, below                                         |
| An administrator | Enables an app and grants its actions to a Bot               | `/admin/plugins/arcade`, then the app's own page, as for Composio |
| Each person      | Connects their own account to that app                       | `/settings/connected-accounts`                                    |

The key is an environment variable and nothing else, as Composio's is. No administrator can turn
Arcade on from a page; `/admin/plugins/arcade` is where a key that is already set gets used.

### Choosing the provider

A deployment runs one broker at a time. `OPENBOT_BROKER_PROVIDER` takes `composio` or `arcade`, and
anything else stops the server at startup.

**Where exactly one of the two keys is set and the variable is unset, that provider is the active
one, so no existing deployment has to set anything.** The variable matters only when both keys are
set. Setting both is legal and expected, because ending an account at the old vendor needs that
vendor's key. With both set and the variable unset, neither is active.

Two refusals protect this, and both are deliberate:

- **A named provider whose key is not set stops the server at startup.** An operator sees: _OPENBOT_BROKER_PROVIDER=arcade names a provider whose ARCADE_API_KEY is not set. Set ARCADE_API_KEY, or change or unset OPENBOT_BROKER_PROVIDER._ It does not fall back to a deployment with no broker, because that would send somebody looking for a broken vendor instead of at their own environment.
- **Activating a provider is refused while the other one still holds connections.** It is keyed on connection rows, not on keys. The message names the provider being activated, how many connections still belong to the other, and tells the operator to keep both keys set and end those connections through the other provider's sunset flow first. Switching by editing the environment would leave accounts nobody can revoke.

## Setting up the Arcade project

### One Arcade project per deployment

Create one Arcade project for each deployment, and do not share. The verifier URL (below) is a
setting of the **project**, and a staging deployment and a production deployment have different
addresses, so they cannot both be pointed at by one project's setting. A project shared between them
would have its verifier pointing at one and failing for the other.

### An OAuth app of your own, per provider

**Arcade's preconfigured providers cannot be used.** Register your own OAuth app at each provider
(Google, GitHub, and so on) and give its client id and secret to Arcade as that provider's
configuration.

This was confirmed the hard way, and the reason matters because it is not a preference. A consent
link was minted for an arbitrary `user_id` against Arcade's default Google provider. It **failed at
verification** with _"the authorization process was not completed"_. The same consent minted for an
Arcade project member's own identity **completed**. Arcade's built-in verifier has to recognise the
end user as a member of the project, so it can only serve a `user_id` that is one. Per-person
connections in OpenBot are arbitrary ids by definition — nobody is made a member of your Arcade
project in order to connect their mailbox — so a default provider cannot serve them at all.

Arcade's admin API can create the OAuth provider, so that part can be scripted.

### The verifier URL is the one dashboard-only step

**The verifier URL cannot be automated.** It is set by hand in the Arcade dashboard, on the project,
and there is no API that does it. It is the single manual step in setting Arcade up, and it is the
one that is easy to do wrongly, so it is stated here rather than left to be discovered.

Set it to this deployment's verifier address, then switch the project to a custom verifier. The
address is this API's public origin — `OPENBOT_PUBLIC_URL`, which defaults to `BETTER_AUTH_URL` —
followed by the path, so paste:

```
<this deployment's public origin>/api/plugins/arcade/verify
```

It is the API's origin, not the browser app's, where the two differ. A browser that arrives there
is sent on to the connected-accounts page, with a reason beside it if the consent was refused.

> **Do not save the custom-verifier setting without a URL.** It switches off the path that currently
> works and switches on nothing — and it presents as _this deployment's own code failing_: consents
> that used to complete stop completing, with nothing in this deployment's logs to explain it. It is
> the trap an operator will otherwise spend an afternoon on. If connections stop completing and
> nothing here changed, look at the project's verifier setting before anything in this deployment.

## What an administrator does

The shape is Composio's: enable an app, grant its actions to a Bot, and each person connects their
own account (or an administrator connects a Shared app's account). Two things are different and
worth reading before pressing **Add**.

### Toolkits are curated or they are wrappers, and the difference is measured

Every action carries a classification — whether it reads or writes, whether it is destructive — and
what OpenBot asks before running it depends on that classification. Arcade publishes it as
`metadata.behavior` on each tool, and toolkits fall into two groups:

| Toolkit     | Tools              | With `metadata.behavior` |
| ----------- | ------------------ | -----------------------: |
| `Github`    | 43                 |                       43 |
| `Asana`     | 19                 |                       19 |
| `GithubApi` | 100 (the page cap) |                    **0** |

Curated toolkits classify every tool. Generated API wrappers classify none. An action that is not
classified is treated as a **destructive write**, because an unlabelled action is not claiming to be
safe. So an administrator enabling an unclassified toolkit is warned **before** finishing that
**every call will ask for approval** — not because anything is wrong with the toolkit, but because
nothing in it can be told apart from a write that cannot be undone. Where a curated toolkit exists
for the app, enable that one.

## Least privilege is not an Arcade property

Do not tell anybody that Arcade gives least-privilege access. It is true for some providers and
false for others, and the same product is on both sides of the line.

Arcade asks for consent per action. What that consent _covers_ depends on whether the provider
issues per-request scopes. Measured, through a completed consent, from a clean baseline:

| Provider                  | Scopes per action                                   | One read consent authorized | Isolation |
| ------------------------- | --------------------------------------------------- | --------------------------- | --------- |
| Google (`Gmail`)          | `gmail.readonly` vs `gmail.send` vs `gmail.compose` | **11 of 30**                | yes       |
| GitHub (via a GitHub App) | **none, for any action**                            | **43 of 43**                | no        |

On Google, consenting to a read authorizes the reads that share its scope and nothing that sends.
On GitHub, consenting to `Github.CountStargazers` — **a read** — flipped all 43 actions to
authorized, **the writes and the destructive one included**, because a GitHub App's permissions are
fixed when the app is registered, and no request can ask for fewer.

> **Least privilege is a property of (provider × how its OAuth app was registered), not of Arcade.**
> What OpenBot does is **measure which it is, per app, and say so before anybody grants anything.**

So when somebody asks whether connecting an app "only lets it read", the answer is whatever that
app's measurement says, not what Arcade says in general. The pre-redirect consent copy names the
permission being asked for and lists the actions that share it, grouped on scopes.

## Scope versus tool grant

Two different questions are easily run together, and an operator will be asked both:

- **Scope** answers _"may this deployment ever read your mail?"_ It is the provider's, it is given
  when somebody consents, and it stays until it is withdrawn at the provider.
- **The tool grant** answers _"may **this Bot** call `ListThreads`?"_ It is an administrator's
  decision, made per Bot, per action.

**Only the second is OpenBot's to give and take instantly**, and no consent widens it. Somebody
consenting to a broad scope does not hand any Bot more actions; a Bot with no grant for an action
cannot call it however much the account allows. On a provider that cannot narrow scopes (GitHub
above), the tool grant is therefore the entire narrowing — the same position as Composio's.

## Disconnecting one app may end another

Arcade's connections are per **auth provider**, not per app. One Google connection serves `Gmail`
and `GoogleCalendar` both, and **no narrower instrument exists** — there is nothing to disconnect
that ends only one of them.

So before somebody confirms a disconnect, OpenBot names the apps that genuinely share the
connection and would end with it. _Genuinely_ is exact: siblings are computed on the **pair (vendor
identity, auth provider)**. Two _Shared_ apps that both use Google do **not** share a connection,
because each Shared app has its own randomly minted identity at Arcade — disconnecting one does not
touch the other, and the confirmation does not claim it would.

## Revoking at Arcade is not revoking at the provider

Google's consent screen is reached with `include_granted_scopes=true`, so **grants accumulate on the
account**. Somebody who consents to a read and later to a write holds both at Google, as one grant.

Disconnect deletes the Arcade connection. That ends **this deployment's** ability to act, and
OpenBot asks for the upstream withdrawal as well, but what the provider then does with the standing
grant happens out of sight. **Nobody should read Disconnect as "my Google account no longer trusts
this."** The person who wants that has to withdraw the grant at the provider itself, and an operator asked
about it should say so rather than reassure.

## The Re-check path, and what an unverified row means

Composio has a one-call probe, `askAction`, that verifies a key and which Re-check runs again.
**It is Composio's own. Arcade has no counterpart in this release.**

What an operator sees on Arcade:

- Pressing **Re-check** **refuses** rather than spending a call. It does not guess at a read to try.
- `probe_action` and `verified_at` are **not written** for an Arcade connection.
- A row therefore carries no "last checked" date.

**Nobody should read an unverified row as a broken connection.** Per-action state on Arcade is not
cached here and compared later: it is read **live from Arcade** — whether the person has authorized
an action is asked of Arcade when the page is drawn, so the answer on screen is Arcade's current
one. A connection that works and has never been "checked" is the normal state, not a fault.

## What is unproven

Nothing in this release has dialled the live Arcade API from this deployment's own code. The
measurements above were taken through completed consents against a live project; the integration
that acts on them is verified against recorded fixtures. Specifically:

- **The `user_mismatch` error shape is assumed.** Arcade's SDK declares no such error, so what the
  deployment recognises as `user_mismatch` — the vendor's answer when the returning consent does
  not belong to the identity the attempt was started for — is the shape expected, not one observed. If a consent is refused for that reason and the page shows a generic failure instead of
  its own sentence, this is where to look.
- **`provider_id` is read as the auth-provider id, not the toolkit name.** That reading is inferred
  from measurements and from a live refusal envelope carrying `"provider_id": "cpk-poc"`. **No
  fixture has a toolkit whose provider is named differently from it**, so it has not been measured
  on a Google-family toolkit — where `Gmail` and `GoogleCalendar` share one provider — and the
  sibling computation above rests on it.
- **The wording of Arcade's dashboard is not described here.** This page says to set the project's
  verifier to the address above and does not name the dashboard's fields or screens, which were not
  checked against it and may change. The address itself is this deployment's.

## See also

- [Composio](composio.md) — the other broker; Personal and Shared apps, approvals and audit work the
  same way.
- [Architecture](../architecture.md) — where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md) — the deployment's settings.
