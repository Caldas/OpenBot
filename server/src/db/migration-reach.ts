/**
 * Whether every migration in the folder can still be reached by the migrator, on THIS database.
 *
 * WHAT THE MIGRATOR ACTUALLY DOES. `PgDialect.migrate` reads one row — the newest `created_at` in
 * `drizzle.__drizzle_migrations` — and then runs a migration if, and only if, its journal `when` is
 * greater than that number. It never looks at hashes, never looks at tags, and never notices that a
 * migration it walked past was one it has never run. A migration whose `when` is at or below the
 * high-water mark is therefore not "pending": it is unreachable, forever, and the migrator will
 * report success without it.
 *
 * WHY THAT IS NOT HYPOTHETICAL. A branch that ships migrations and is then merged with `main` has
 * its own migrations renumbered and restamped to sit after main's. Every database that ran the
 * branch BEFORE the merge has already recorded the branch's old, higher stamp. Main's migrations
 * now carry a `when` older than that mark, so they are skipped — silently — while the renumbered
 * branch migrations, stamped later still, run perfectly. The database ends up missing tables that
 * the migrator just said it had applied. A fresh database is unaffected, which is exactly why CI,
 * which always migrates from empty, cannot see it.
 *
 * WHY THIS REFUSES RATHER THAN REPAIRS. Running the unreachable SQL and backfilling its row is a
 * two-line change and the wrong one. The migrations that are out of reach are out of reach because
 * some OTHER journal already ran against this database, and nothing here knows what that journal
 * did — whether its statements created the same objects under other names, left half a schema
 * behind, or were the hand-repair of an earlier failure. The honest answer to "this database cannot
 * be brought up to date by running the folder forward" is to say so, loudly, with the names in
 * hand, and to stop. An operator can then drop a disposable database, or repair a durable one
 * deliberately. What must never happen again is `{"type":"migrations-applied","status":"ok"}` over
 * tables that do not exist.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** One migration in the folder, as the migrator reads it. */
export type FolderMigration = {
  tag: string;
  /** The journal's `when`: the only thing the migrator compares. */
  when: number;
  /**
   * sha256 of the whole `.sql` file, hex.
   *
   * Computed exactly as `drizzle-orm/migrator`'s `readMigrationFiles` computes it — the whole file
   * as read, before any statement splitting — because this is matched against the hashes that the
   * migrator itself wrote into `drizzle.__drizzle_migrations`. A different recipe here would make
   * every applied migration look unapplied.
   */
  hash: string;
};

/** One row of `drizzle.__drizzle_migrations`. */
export type AppliedMigration = { hash: string; createdAt: number };

type Journal = { entries: { idx: number; tag: string; when: number }[] };

/**
 * The folder, read the way the migrator reads it: the journal decides, not the directory listing.
 *
 * A `.sql` file with no journal entry never runs and is not this function's business; an entry with
 * no file stops the migrator dead, and `readFile` rejecting here says so in the same breath.
 */
export async function readMigrationFolder(
  folder: string,
): Promise<FolderMigration[]> {
  const journal = JSON.parse(
    await readFile(join(folder, "meta", "_journal.json"), "utf8"),
  ) as Journal;

  return Promise.all(
    journal.entries.map(async (entry) => ({
      tag: entry.tag,
      when: entry.when,
      hash: createHash("sha256")
        .update(await readFile(join(folder, `${entry.tag}.sql`), "utf8"))
        .digest("hex"),
    })),
  );
}

/**
 * The migrations this database can no longer reach: never applied, and stamped at or below the
 * high-water mark the migrator will compare them against.
 *
 * An empty `applied` is a database the migrator has never touched, where everything is reachable by
 * definition — a fresh database can never be in this trouble, and saying so explicitly keeps the
 * check from having an opinion about the one case it has no evidence for.
 */
export function migrationsOutOfReach(
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
): FolderMigration[] {
  if (applied.length === 0) return [];

  const highWaterMark = Math.max(...applied.map((row) => row.createdAt));
  const appliedHashes = new Set(applied.map((row) => row.hash));

  return folder.filter(
    (migration) =>
      migration.when <= highWaterMark && !appliedHashes.has(migration.hash),
  );
}

/**
 * The refusal, written for whoever is reading a failed deploy at an unreasonable hour.
 *
 * It names the mark and what set it, every migration that cannot be reached, and the two ways out,
 * because the one thing an operator cannot work out from a stack trace is that the database is
 * *ahead* of the folder rather than behind it.
 */
export function outOfReachRefusal(
  outOfReach: readonly FolderMigration[],
  folder: readonly FolderMigration[],
  applied: readonly AppliedMigration[],
): string {
  const highWaterMark = Math.max(...applied.map((row) => row.createdAt));
  const inFolder = new Set(folder.map((migration) => migration.hash));
  /*
   * Rows this folder cannot account for. Not a failure on its own — a squashed or deleted migration
   * leaves them too — but when migrations are out of reach these rows are almost always the reason,
   * so the count is the fastest thing an operator can act on.
   */
  const unknown = applied.filter((row) => !inFolder.has(row.hash)).length;
  const mark =
    folder.find((migration) => migration.when === highWaterMark)?.tag ??
    "a migration this folder does not contain";

  return [
    `This database has already recorded a migration stamped ${highWaterMark} (${mark}), and the migrator only runs migrations stamped after the newest one it finds.`,
    `${outOfReach.length === 1 ? "This migration is" : `These ${outOfReach.length} migrations are`} stamped at or below that mark and ${outOfReach.length === 1 ? "has" : "have"} never been applied here, so running the migrator would skip ${outOfReach.length === 1 ? "it" : "them"} and report success over the schema ${outOfReach.length === 1 ? "it" : "they"} should have created:`,
    ...outOfReach.map(
      (migration) => `  - ${migration.tag} (stamped ${migration.when})`,
    ),
    unknown === 0
      ? "Every applied migration is still present in this folder."
      : `${unknown} applied ${unknown === 1 ? "migration is" : "migrations are"} not in this folder at all, which is what a renumbered or rewritten migration history looks like from here: this database ran a journal that no longer exists.`,
    "Nothing has been applied. Recreate the database from empty if it is disposable (a development, preview or CI database usually is); otherwise apply the SQL above by hand and record each one with `insert into drizzle.__drizzle_migrations (hash, created_at) values (<sha256 of the file>, <its journal when>)`, which leaves the high-water mark where it is.",
  ].join("\n");
}
