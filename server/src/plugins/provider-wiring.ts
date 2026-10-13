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
 * `activeProvider` answers `null` in three situations: no keys, both keys with nothing named, and
 * a named provider whose key is unset or blank. The first two are legal states. The third is an
 * operator typo, and degrading it to a deployment with no broker would send them looking for a broken
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
  const provider = activeProvider(c);
  if (provider === null && c.brokerProvider !== undefined) {
    const keyName =
      c.brokerProvider === "arcade" ? "ARCADE_API_KEY" : "COMPOSIO_API_KEY";
    throw new Error(
      `OPENBOT_BROKER_PROVIDER=${c.brokerProvider} names a provider whose ${keyName} is not set to a key. Set ${keyName} to this deployment's key, or change or unset OPENBOT_BROKER_PROVIDER.`,
    );
  }
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
