import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { mcpServers } from "../db/schema";
import type { BrokerProvider } from "./access";
import { toolkitOf as arcadeToolkitOf } from "./arcade";
import type { ComposioBroker } from "./broker";
import { toolkitOf as composioToolkitOf } from "./composio";

/**
 * The url parser that matches the provider a row is provenanced at. The two schemes name apps under
 * different rules, so a row is read by its own broker's parser or not at all.
 */
const TOOLKIT_OF: Record<BrokerProvider, (url: string) => string | null> = {
  composio: composioToolkitOf,
  arcade: arcadeToolkitOf,
};

/** Fill older app records without changing their connections, schemes, or grants. */
export async function backfillBrokeredLogos(
  database: Database,
  provider: BrokerProvider,
  broker: Pick<ComposioBroker, "listApps">,
) {
  const toolkitOf = TOOLKIT_OF[provider];
  const missing = await database
    .select({ id: mcpServers.id, url: mcpServers.url })
    .from(mcpServers)
    .where(and(eq(mcpServers.provenance, provider), isNull(mcpServers.logo)));
  if (missing.length === 0) return;

  const logos = new Map(
    (await broker.listApps()).map((app) => [app.slug, app.logo]),
  );
  for (const row of missing) {
    const slug = toolkitOf(row.url);
    const logo = slug ? logos.get(slug) : null;
    if (!logo) continue;
    await database
      .update(mcpServers)
      .set({ logo })
      .where(
        and(
          eq(mcpServers.id, row.id),
          eq(mcpServers.url, row.url),
          eq(mcpServers.provenance, provider),
          isNull(mcpServers.logo),
        ),
      );
  }
}
