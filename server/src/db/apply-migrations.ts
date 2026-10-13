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
 * What the migrator has already recorded here, or nothing at all.
 *
 * `to_regclass` rather than a query that may fail: a database the migrator has never touched has no
 * `drizzle` schema, and selecting from a table that is not there would be an error indistinguishable
 * from a database that cannot be read.
 */
async function appliedMigrations(client: Sql): Promise<AppliedMigration[]> {
  const [present] = await client<{ table: string | null }[]>`
    select to_regclass('drizzle.__drizzle_migrations')::text as table
  `;
  if (!present?.table) return [];

  const rows = await client<{ hash: string; created_at: string | null }[]>`
    select hash, created_at from drizzle.__drizzle_migrations
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
): Promise<void> {
  const folder = await readMigrationFolder(migrationsFolder);
  const applied = await appliedMigrations(client);

  const outOfReach = migrationsOutOfReach(folder, applied);
  if (outOfReach.length > 0) {
    throw new MigrationsOutOfReachError(
      outOfReachRefusal(outOfReach, folder, applied),
    );
  }

  await migrate(drizzle(client), { migrationsFolder });
}
