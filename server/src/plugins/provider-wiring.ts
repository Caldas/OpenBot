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
 * Configuration names no provider in three situations: no keys, both keys with nothing named, and
 * a named provider whose key is unset. The first two are legal states. The third is an operator
 * typo, and degrading it to a deployment with no broker would send them looking for a broken
 * vendor instead of at their own environment, so it is refused here, naming the variables and
 * never a value.
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
      `OPENBOT_BROKER_PROVIDER=${decision.named} names a provider whose ${keyName} is not set. Set ${keyName}, or change or unset OPENBOT_BROKER_PROVIDER.`,
    );
  }
  const provider = decision.kind === "active" ? decision.provider : null;
  if (provider === "arcade" && c.arcadeApiKey !== undefined) {
    const client = create.arcade(c.arcadeApiKey);
    return {
      provider,
      broker: client.broker,
      install: { composio: null, arcade: client.actions },
    };
  }
  if (provider === "composio" && c.composioApiKey !== undefined) {
    const client = create.composio(c.composioApiKey);
    return {
      provider,
      broker: client.broker,
      install: { composio: client.actions, arcade: null },
    };
  }
  return {
    provider: null,
    broker: null,
    install: { composio: null, arcade: null },
  };
}

/**
 * WHICH SLICE of `brokered_connections` this deployment's stores read and write, which is a
 * different question from which broker is active, and has an answer where that one has none.
 *
 * CONFIGURATION FIRST, THEN THE ROWS, AND NEVER A VENDOR PICKED OUT OF THE AIR. An active provider
 * is the answer. Where configuration names none — no key set, or both keys set with
 * `OPENBOT_BROKER_PROVIDER` unset, which is a legal state a migrating deployment passes through —
 * the rows this deployment actually holds name it instead. That is the whole fix: `?? "composio"`
 * answered "Composio" for a deployment whose every connection is an Arcade one, so those rows were
 * filtered out of every read, parsed with the wrong parser, and the live accounts behind them could
 * be neither seen nor revoked. Asking the rows cannot be wrong about them, because they are what is
 * being named.
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
