import { type PluginsPage, pluginsProvider } from "./queries";

/**
 * The words an admin Plugins screen uses for the ACTIVE broker, and nothing of the other's (spec D11).
 *
 * TWO DIFFERENT QUESTIONS, AND CONFLATING THEM IS THE TRAP. A screen that FILTERS by brokered-ness
 * needs no provider name: one provider holds rows at a time (spec D3), so {@link brokeredProvenance}
 * answers it from the row. A screen that NAMES a vendor cannot derive the name from a row that
 * happens to exist — a deployment with the key set and no app enabled yet has no row at all — so it
 * reads {@link pluginsProvider} and asks this module for the words.
 *
 * Pure functions, so the vocabulary is pinned without a DOM. Nothing here carries a key or a
 * capability: the provider is a NAME.
 */
export type PluginsProvider = NonNullable<PluginsPage["provider"]>;

/** Whether a row came through a broker, whichever one. Filters; never names. */
export function brokeredProvenance(provenance: string): boolean {
  return provenance === "composio" || provenance === "arcade";
}

export type ProviderVocabulary = {
  /** The vendor's display name. */
  name: string;
  /** The directory entry's label, as the "More apps" row and the picker title say it. */
  directoryLabel: string;
  /** The environment variable an operator sets to turn the broker on. */
  envVar: string;
  /** The route path of the vendor's directory screen. */
  directoryPath: string;
};

const VOCABULARY: Record<PluginsProvider, ProviderVocabulary> = {
  composio: {
    name: "Composio",
    directoryLabel: "Browse Composio",
    envVar: "COMPOSIO_API_KEY",
    directoryPath: "/admin/plugins/composio",
  },
  arcade: {
    name: "Arcade",
    directoryLabel: "Browse Arcade",
    envVar: "ARCADE_API_KEY",
    directoryPath: "/admin/plugins/arcade",
  },
};

export function providerVocabulary(
  provider: PluginsProvider,
): ProviderVocabulary {
  return VOCABULARY[provider];
}

/** The "More apps" section's own sentence. */
export function moreAppsSectionDescription(provider: PluginsProvider): string {
  return `A directory this deployment has not reviewed, reached through ${VOCABULARY[provider].name}.`;
}

/**
 * The one row under "More apps".
 *
 * `linked` is whether the row goes anywhere. Only Composio has a directory screen today, so an
 * Arcade row states its setting and links nowhere; a Composio row links exactly when configured.
 */
export type MoreAppsRow = {
  title: string;
  description: string;
  linked: boolean;
};

export function moreAppsRow(
  provider: PluginsProvider,
  configured: boolean,
): MoreAppsRow {
  const { name, directoryLabel, envVar } = VOCABULARY[provider];
  if (!configured) {
    return {
      title: name,
      description: `Add your ${name} key to enable a catalogue of tools. Set ${envVar} on this deployment.`,
      linked: false,
    };
  }
  if (provider === "composio") {
    return {
      title: directoryLabel,
      description:
        "A few hundred apps, reached as whoever is asking. Each person connects their own account.",
      linked: true,
    };
  }
  return {
    title: name,
    description: `${name} is configured on this deployment. Each person connects their own account.`,
    linked: false,
  };
}

/** The Connection card's sentence for a brokered app. */
export function brokeredConnectionDescription(
  provider: PluginsProvider,
): string {
  return `Reached through ${VOCABULARY[provider].name}, which holds each person's own account.`;
}

/** The "How this is reached" row for a brokered app: its sentence and its badge. */
export function brokeredReach(provider: PluginsProvider): {
  description: string;
  badge: string;
} {
  const { name } = VOCABULARY[provider];
  return {
    description: `This app is reached through ${name}, which holds the account. This deployment sends one key and the name of whoever is asking, so each person connects their own and a Bot sees only what that person can see. There is no token to paste.`,
    badge: `Through ${name}`,
  };
}

/** What disconnecting a brokered account does, said where the button is. */
export function brokeredDisconnectNote(provider: PluginsProvider): string {
  return `Disconnecting ends the account at ${VOCABULARY[provider].name}, not just here.`;
}

/**
 * Whether a directory route may answer on this deployment.
 *
 * `pending` until the page has said which provider this is: the default of `"composio"` is right for
 * a label and wrong for a gate, because acting on it would fire a Composio request against an Arcade
 * project in the moment before the answer arrives.
 */
export function directoryRouteDecision(
  routeProvider: PluginsProvider,
  page: PluginsPage | undefined,
): "pending" | "render" | "redirect" {
  if (!page) return "pending";
  return pluginsProvider(page) === routeProvider ? "render" : "redirect";
}
