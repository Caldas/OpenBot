/**
 * Apply a migration folder to a database, or refuse before touching it.
 *
 * Separate from `scripts/migrate.ts` so that the refusal has a test. The script is an executable —
 * it reads the environment and exits — and the only way to find out what it does to a database that
 * is one journal out of step is to run it against such a database, which is what
 * `tests/migration-reach.integration.test.ts` does through this function.
 *
 * See `./migration-reach` for what is being checked and why the answer is a refusal rather than a
 * repair.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";
import {
  type AppliedMigration,
  migrationsOutOfReach,
  outOfReachRefusal,
  readMigrationFolder,
} from "./migration-reach";

/**
 * Where the migrator keeps its bookkeeping, named once.
 *
 * `migrate()` writes to whatever `migrationsSchema` / `migrationsTable` it is handed, and the
 * reach check below reads the same table to decide whether migrating is safe. If the two ever named
 * different tables the check would read an absent table, see nothing applied, and wave every
 * migration through — the refusal silently switched off. So both are handed this one object, and
 * nothing else in the server spells the name.
 */
export type MigrationsJournal = {
  migrationsSchema: string;
  migrationsTable: string;
};

export const MIGRATIONS_JOURNAL: MigrationsJournal = {
  migrationsSchema: "drizzle",
  migrationsTable: "__drizzle_migrations",
};

/**
 * What the migrator has already recorded here, or nothing at all.
 *
 * `to_regclass` rather than a query that may fail: a database the migrator has never touched has no
 * journal schema, and selecting from a table that is not there would be an error indistinguishable
 * from a database that cannot be read.
 */
async function appliedMigrations(
  client: Sql,
  { migrationsSchema, migrationsTable }: MigrationsJournal,
): Promise<AppliedMigration[]> {
  const [present] = await client<{ table: string | null }[]>`
    select to_regclass(format('%I.%I', ${migrationsSchema}::text, ${migrationsTable}::text))::text as table
  `;
  if (!present?.table) return [];

  const rows = await client<{ hash: string; created_at: string | null }[]>`
    select hash, created_at from ${client(migrationsSchema)}.${client(migrationsTable)}
  `;
  return rows.map((row) => ({
    hash: row.hash,
    createdAt: Number(row.created_at ?? 0),
  }));
}

/** Thrown instead of migrating, when migrating would skip work and call it done. */
export class MigrationsOutOfReachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationsOutOfReachError";
  }
}

export async function applyMigrations(
  client: Sql,
  migrationsFolder: string,
  journal: MigrationsJournal = MIGRATIONS_JOURNAL,
): Promise<void> {
  const folder = await readMigrationFolder(migrationsFolder);
  const applied = await appliedMigrations(client, journal);

  const outOfReach = migrationsOutOfReach(folder, applied);
  if (outOfReach.length > 0) {
    throw new MigrationsOutOfReachError(
      outOfReachRefusal(outOfReach, folder, applied),
    );
  }

  await migrate(drizzle(client), { migrationsFolder, ...journal });
}
