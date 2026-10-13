import type { ArcadeActions } from "./arcade";
import type { ComposioActions } from "./composio";
import {
  providerDecision,
  type ConnectedAppBroker,
  type ProviderDecision,
} from "./broker";
import { BROKERED_PROFILE, type BrokerProvider } from "./access";

/**
 * The entrypoint's provider decision, with the vendor constructors passed in so this file imports
 * no vendor package and a test can answer without booting the server or making a request.
 */
type ClientFactory<Actions> = (apiKey: string) => {
  actions: Actions;
  broker: ConnectedAppBroker;
};

export type ProviderWiring = {
  /** The one active provider, or `null` for a deployment that legitimately has no broker. */
  provider: BrokerProvider | null;
  /** The one broker handed to the store and the routes; `null` exactly when `provider` is. */
  broker: ConnectedAppBroker | null;
  /** Both transport seams, always both: the one that is not active is explicitly `null`. */
  install: { composio: ComposioActions | null; arcade: ArcadeActions | null };
};

/**
 * Chooses ONE provider from configuration and builds only that provider's client.
 *
 * {@link providerDecision} answers one of four kinds, and this function has exactly one outcome for
 * each, which is the point: the three causes of "no provider" were a single `null` before, and
 * every caller that then wrote `?? "composio"` turned the one cause that can hold Arcade rows into
 * "Composio is active".
 *
 * `active` wires that provider. `unconfigured` — no key at all — is the ONLY one wired to nothing:
 * nobody configured a broker, so having none is the answer the configuration asked for.
 *
 * `misnamed` AND `ambiguous` ARE REFUSED RATHER THAN DEGRADED. A named provider whose key is unset
 * or blank is an operator typo. Both keys set with nothing named is an operator half-way through a
 * sunset who has not said which vendor is live — not a state anybody wants on purpose, because the
 * deployment comes up holding two vendor keys and brokering nothing, so every brokered feature is
 * dead. Returning null wiring for either would be a failure nobody is told about at boot: the
 * symptom surfaces much later and far away, as features that simply do not work, and sends an
 * operator looking for a broken vendor instead of at their own environment. Both are refused here,
 * naming the variables and never a value.
 *
 * BOTH-KEYS IS COUNTED WITH `credential`, inside {@link providerDecision}, not with
 * `!== undefined`. A deployment holding two BLANK keys has configured no vendor at all, and must be
 * told that rather than that both of its vendors are set.
 *
 * NO BRANCH BELOW REACHES NULL WIRING BY FALLING THROUGH. The one null wiring is returned from the
 * branch that means it, and a selected provider whose key is somehow absent throws rather than
 * quietly becoming the same thing — see the invariant below.
 */
export function selectProviderWiring(
  c: {
    composioApiKey?: string;
    arcadeApiKey?: string;
    brokerProvider?: BrokerProvider;
  },
  create: {
    composio: ClientFactory<ComposioActions>;
    arcade: ClientFactory<ArcadeActions>;
  },
): ProviderWiring {
  const decision = providerDecision(c);
  if (decision.kind === "misnamed") {
    const keyName = BROKERED_PROFILE[decision.named].envVar;
    throw new Error(
      `OPENBOT_BROKER_PROVIDER=${decision.named} names a provider whose ${keyName} is not set to a key. Set ${keyName} to this deployment's key, or change or unset OPENBOT_BROKER_PROVIDER.`,
    );
  }
  if (decision.kind === "ambiguous") {
    throw new Error(
      "COMPOSIO_API_KEY and ARCADE_API_KEY are both set and OPENBOT_BROKER_PROVIDER is unset, so no provider is active and nothing brokered would work. Set OPENBOT_BROKER_PROVIDER to composio or arcade to say which vendor is live, or unset the key of the vendor this deployment is not using.",
    );
  }
  if (decision.kind === "unconfigured") {
    // Neither key set: a deployment that asked for no broker, and gets exactly that.
    return {
      provider: null,
      broker: null,
      install: { composio: null, arcade: null },
    };
  }
  const provider = decision.provider;
  if (provider === "arcade") {
    const client = create.arcade(
      requiredKey(provider, c.arcadeApiKey, "ARCADE_API_KEY"),
    );
    return {
      provider,
      broker: client.broker,
      install: { composio: null, arcade: client.actions },
    };
  }
  const client = create.composio(
    requiredKey(provider, c.composioApiKey, "COMPOSIO_API_KEY"),
  );
  return {
    provider,
    broker: client.broker,
    install: { composio: client.actions, arcade: null },
  };
}

/**
 * The key a selected provider must have, demanded rather than tested.
 *
 * {@link providerDecision} selects a provider only from a key it has seen, so this cannot fire today.
 * It is written as a demand because of what the alternative WAS: the two branches above each
 * carried `&& c.<vendor>ApiKey !== undefined`, which made a selected provider with no key fall
 * through to null wiring — the broker silently unwired, by the very code whose job is to wire it.
 * A narrowing that doubles as a silent exit is the shape this finding is about, so the narrowing is
 * kept and the exit is removed: if the two ever disagree, the deployment says so at boot.
 */
function requiredKey(
  provider: BrokerProvider,
  apiKey: string | undefined,
  keyName: string,
): string {
  if (apiKey !== undefined) return apiKey;
  throw new Error(
    `${provider} was selected as the broker but ${keyName} is not set. This is a bug in provider selection, not a configuration error; no broker was wired.`,
  );
}

/**
 * WHICH SLICE of `brokered_connections` this deployment's stores read and write, which is a
 * different question from which broker is active, and has an answer where that one has none.
 *
 * CONFIGURATION FIRST, THEN THE ROWS, AND NEVER A VENDOR PICKED OUT OF THE AIR. An active provider
 * is the answer. Where configuration names none — a broker key withdrawn after rows were made —
 * the rows this deployment actually holds name it instead. That is the whole fix: `?? "composio"`
 * answered "Composio" for a deployment whose every connection is an Arcade one, so those rows were
 * filtered out of every read, parsed with the wrong parser, and the live accounts behind them could
 * be neither seen nor revoked. Asking the rows cannot be wrong about them, because they are what is
 * being named.
 *
 * AMBIGUOUS CONFIGURATION NEVER REACHES HERE AT BOOT. {@link selectProviderWiring} refuses both
 * keys set with nothing named before any store is built, so the `ambiguous` arm below is reachable
 * only by a direct caller (a test). What DOES reach here is `unconfigured` — no key at all — where
 * rows can still outlive a withdrawn key and must be read as their own provider's.
 *
 * ROWS AT BOTH VENDORS WITH NOTHING ACTIVE IS REFUSED, which is {@link assertActivatable}'s refusal
 * from the other side: that one stops a deployment activating one provider while the other holds
 * rows, and this one stops a deployment reading one vendor's rows as the other's while NOTHING is
 * active. Both say the same thing to an operator — name a provider, and end the other's connections
 * through its own sunset flow.
 *
 * AND NO ROWS AT ALL NAMES AN EMPTY SLICE. A `BrokerProvider` has to be spelled, and with no row of
 * either vendor there is no row to misfile: every `eq(provider, …)` selects nothing whichever name
 * is used, and no row can appear while this holds, because writing one needs a live broker and
 * there is none. The name is a label on an empty set, not a claim that Composio is active — what
 * answers that is `providerWiring.broker`, which is `null` here.
 */
export function storedProvider(
  decision: ProviderDecision,
  rowOwners: BrokerProvider[],
): BrokerProvider {
  if (decision.kind === "active") return decision.provider;
  if (decision.kind === "misnamed") {
    // Unreachable: `selectProviderWiring` stops the server on this before any store is built.
    throw new Error(
      `OPENBOT_BROKER_PROVIDER=${decision.named} names a provider whose ${BROKERED_PROFILE[decision.named].envVar} is not set.`,
    );
  }
  const owners = [...new Set(rowOwners)];
  if (owners.length > 1) {
    const counted = owners
      .map((owner) => BROKERED_PROFILE[owner].vendor)
      .join(" and ");
    throw new Error(
      `This deployment holds brokered connections at ${counted}, and nothing names which provider is active: ${
        decision.kind === "ambiguous"
          ? `${decision.configured.map((p) => BROKERED_PROFILE[p].envVar).join(" and ")} are both set and OPENBOT_BROKER_PROVIDER is unset`
          : "no broker API key is set"
      }. Set OPENBOT_BROKER_PROVIDER to the provider those connections are to be read as, and end the other provider's connections through its own sunset flow.`,
    );
  }
  const owner = owners[0];
  if (owner !== undefined) return owner;
  // No rows of either vendor. See the last paragraph above: this labels an empty set.
  return "composio";
}
