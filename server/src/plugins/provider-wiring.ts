import type { ArcadeActions } from "./arcade";
import type { ComposioActions } from "./composio";
import { activeProvider, type ConnectedAppBroker } from "./broker";
import type { BrokerProvider } from "./access";

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
 * `activeProvider` answers `null` in three situations, and only ONE of them is a deployment this
 * function may wire to nothing: no keys at all. That one is unambiguous — nobody configured a
 * broker, so having none is the answer the configuration asked for, and every brokered surface
 * already says the connector is not configured here.
 *
 * THE OTHER TWO ARE AMBIGUOUS CONFIGURATION, AND AMBIGUITY IS REFUSED RATHER THAN DEGRADED. A
 * named provider whose key is unset is an operator typo. Both keys set with nothing named is an
 * operator half-way through a sunset who has not said which vendor is live — and it is not a state
 * anybody wants on purpose, because the deployment comes up holding two vendor keys and brokering
 * nothing, so every brokered feature is dead. Returning null wiring for either would be a failure
 * nobody is told about at boot: the symptom surfaces much later and far away, as features that
 * simply do not work, and sends an operator looking for a broken vendor instead of at their own
 * environment. Both are therefore refused here, naming the variables and never a value.
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
  const provider = activeProvider(c);
  if (provider === null) {
    if (c.brokerProvider !== undefined) {
      const keyName =
        c.brokerProvider === "arcade" ? "ARCADE_API_KEY" : "COMPOSIO_API_KEY";
      throw new Error(
        `OPENBOT_BROKER_PROVIDER=${c.brokerProvider} names a provider whose ${keyName} is not set. Set ${keyName}, or change or unset OPENBOT_BROKER_PROVIDER.`,
      );
    }
    if (c.composioApiKey !== undefined && c.arcadeApiKey !== undefined) {
      throw new Error(
        "COMPOSIO_API_KEY and ARCADE_API_KEY are both set and OPENBOT_BROKER_PROVIDER is unset, so no provider is active and nothing brokered would work. Set OPENBOT_BROKER_PROVIDER to composio or arcade to say which vendor is live, or unset the key of the vendor this deployment is not using.",
      );
    }
    // Neither key set: a deployment that asked for no broker, and gets exactly that.
    return {
      provider: null,
      broker: null,
      install: { composio: null, arcade: null },
    };
  }
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
 * {@link activeProvider} selects a provider only from a key it has seen, so this cannot fire today.
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
