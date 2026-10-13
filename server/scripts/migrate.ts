/**
 * Apply the migrations, using only what a running deployment already has.
 *
 * NOT `drizzle-kit migrate`, and that is the whole point of this file. The CLI is a development
 * dependency: it reads `drizzle.config.ts`, which means compiling TypeScript, which means the esbuild
 * that `bun install --production` correctly leaves out of a runtime image. Asked to migrate there it
 * prints "Reading config file", exits 1, and says nothing at all, so a deployment looks like it
 * migrated and comes up against an empty database complaining that `users` does not exist.
 *
 * The migrator underneath it is part of `drizzle-orm`, which is a runtime dependency because the
 * server imports it anyway. It needs a connection and the folder of SQL files, both of which are in
 * the image, and it keeps the same `drizzle.__drizzle_migrations` journal the CLI does, so the two
 * are interchangeable and a database migrated by either is migrated.
 *
 * It is now what every path runs — the image, the Helm Job, the compose stack, CI, and `db:migrate`
 * — because the two stopped being interchangeable in the direction that matters: only this one
 * refuses a database holding a stamp newer than a migration it is about to walk past. See
 * `src/db/migration-reach`.
 */
import { join } from "node:path";
import postgres from "postgres";
import { applyMigrations } from "../src/db/apply-migrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL must be configured before running a database migration command",
  );
}

/*
 * One connection, and `max: 1`.
 *
 * Migrations are a single ordered conversation with the database, and a pool would let two
 * statements that must be ordered land on different connections.
 */
const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

try {
  /*
   * Guarded, because the migrator's own idea of "applied" is one number.
   *
   * It runs a migration when the journal stamps it later than the newest stamp the database holds,
   * and it has nothing to say about a migration stamped earlier that it has never run. See
   * `src/db/migration-reach`: a database that ran a branch's migrations before that branch was
   * merged and renumbered holds a stamp newer than the migrations the merge brought in, and the
   * unguarded migrator walks past them and prints the line below anyway.
   */
  await applyMigrations(client, join(import.meta.dir, "..", "drizzle"));
  console.info(JSON.stringify({ type: "migrations-applied", status: "ok" }));
} finally {
  // Released whatever happened, so a failure exits rather than hanging on an open socket.
  await client.end({ timeout: 5 });
}
