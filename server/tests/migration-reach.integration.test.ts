import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  applyMigrations,
  MIGRATIONS_JOURNAL,
  type MigrationsJournal,
  MigrationsOutOfReachError,
} from "../src/db/apply-migrations";
import { testDatabaseUrl } from "./support/database";

/**
 * The renumber, run for real, because the whole defect is what a real migrator does to a real
 * database and nothing short of one can show it.
 *
 * A database is created per case and dropped afterwards. A schema inside the shared test database
 * would not do: the migrator's own bookkeeping lives in one table (`MIGRATIONS_JOURNAL`), and these
 * cases are entirely about what that one table already contains, so they need a database whose
 * contents nothing else wrote.
 *
 * The migrations below are two statements long on purpose. The journal that matters here is the
 * sequence of stamps, not the SQL, and this file has no business taking seconds to re-run the
 * fifty-odd real ones twice per case.
 */

const server = new URL(testDatabaseUrl());
const administrative = new URL(server.href);
administrative.pathname = "/postgres";

const created: string[] = [];

async function throwawayDatabase(): Promise<string> {
  const name = `openbot_reach_${Math.random().toString(36).slice(2, 10)}`;
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  created.push(name);
  const url = new URL(server.href);
  url.pathname = `/${name}`;
  return url.href;
}

afterAll(async () => {
  const admin = postgres(administrative.href, { max: 1, onnotice: () => {} });
  try {
    for (const name of created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

type Entry = { tag: string; when: number; sql: string };

/** A migration folder on disk, in the shape `readMigrationFiles` insists on. */
async function folderOf(entries: Entry[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "migration-reach-"));
  await mkdir(join(directory, "meta"), { recursive: true });
  for (const entry of entries) {
    await writeFile(join(directory, `${entry.tag}.sql`), entry.sql);
  }
  await writeFile(
    join(directory, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((entry, idx) => ({
        idx,
        version: "7",
        when: entry.when,
        tag: entry.tag,
        breakpoints: true,
      })),
    }),
  );
  return directory;
}

const first: Entry = {
  tag: "0000_first",
  when: 1_000_000,
  sql: 'CREATE TABLE "first" ("id" text PRIMARY KEY);\n',
};

/** The branch's own migration, as it shipped before the merge renumbered it. */
const asShipped: Entry = {
  tag: "0001_branch",
  when: 3_000_000,
  sql: 'CREATE TABLE "branch" ("id" text PRIMARY KEY);\n',
};

const exists = async (client: postgres.Sql, table: string) => {
  const [row] = await client<{ present: string | null }[]>`
    select to_regclass(${`public.${table}`})::text as present
  `;
  return row?.present !== null && row?.present !== undefined;
};

describe("a database that ran a branch before the branch was merged", () => {
  test("is refused, rather than migrated past the work it cannot reach", async () => {
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await applyMigrations(client, await folderOf([first, asShipped]));
      expect(await exists(client, "branch")).toBe(true);

      /*
       * The merge: main's migration takes the number the branch's had, stamped when main's author
       * generated it — before the branch shipped — and the branch's work is restamped after both.
       * The unguarded migrator runs `0002`, walks past `0001`, and reports success.
       */
      const merged = await folderOf([
        first,
        {
          tag: "0001_from_main",
          when: 2_000_000,
          sql: 'CREATE TABLE "from_main" ("id" text PRIMARY KEY);\n',
        },
        {
          ...asShipped,
          tag: "0002_branch_renumbered",
          when: 4_000_000,
          sql: 'ALTER TABLE "branch" ADD COLUMN "renumbered" boolean;\n',
        },
      ]);

      const refusal = await applyMigrations(client, merged).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(MigrationsOutOfReachError);
      expect((refusal as Error).message).toContain(
        "0001_from_main (stamped 2000000)",
      );

      // And refused before anything ran, rather than part way through: the database is exactly as
      // the branch left it, which is the state an operator can reason about.
      expect(await exists(client, "from_main")).toBe(false);
      const [row] = await client<{ count: string }[]>`
        select count(*)::text as count
        from ${client(MIGRATIONS_JOURNAL.migrationsSchema)}.${client(MIGRATIONS_JOURNAL.migrationsTable)}
      `;
      expect(row?.count).toBe("2");
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  test("is refused before the statement that would have failed on it", async () => {
    /*
     * The other half, and the one that at least announces itself. Where the renumbered migration
     * recreates a table the branch already created, the unguarded migrator dies on `CREATE TABLE`
     * with a duplicate — after having skipped the migration below the mark, so that the obvious
     * hand repair (drop the table, run again) is what turns a loud failure into a silent one.
     */
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await applyMigrations(client, await folderOf([first, asShipped]));

      const merged = await folderOf([
        first,
        {
          tag: "0001_from_main",
          when: 2_000_000,
          sql: 'CREATE TABLE "from_main" ("id" text PRIMARY KEY);\n',
        },
        { ...asShipped, tag: "0002_branch_renumbered", when: 4_000_000 },
      ]);

      await expect(applyMigrations(client, merged)).rejects.toThrow(
        MigrationsOutOfReachError,
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

describe("a journal kept somewhere other than the default", () => {
  /*
   * The check and the migrator must read and write the same bookkeeping table. Were the check to
   * look somewhere fixed while the migrator honoured its configuration, the check would find no
   * table, conclude nothing had been applied, and let the migrator walk past the unreachable
   * migration exactly as if there were no check at all.
   */
  const elsewhere: MigrationsJournal = {
    migrationsSchema: "c4_journal",
    migrationsTable: "applied_migrations",
  };

  test("is the table the check reads, so a renumber is still refused", async () => {
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await applyMigrations(
        client,
        await folderOf([first, asShipped]),
        elsewhere,
      );

      const merged = await folderOf([
        first,
        {
          tag: "0001_from_main",
          when: 2_000_000,
          sql: 'CREATE TABLE "from_main" ("id" text PRIMARY KEY);\n',
        },
        {
          ...asShipped,
          tag: "0002_branch_renumbered",
          when: 4_000_000,
          sql: 'ALTER TABLE "branch" ADD COLUMN "renumbered" boolean;\n',
        },
      ]);

      const refusal = await applyMigrations(client, merged, elsewhere).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(MigrationsOutOfReachError);
      expect(await exists(client, "from_main")).toBe(false);

      // And the bookkeeping is where it was configured to be, and nowhere else.
      const [row] = await client<{ count: string }[]>`
        select count(*)::text as count
        from ${client(elsewhere.migrationsSchema)}.${client(elsewhere.migrationsTable)}
      `;
      expect(row?.count).toBe("2");
      const [fallback] = await client<{ present: string | null }[]>`
        select to_regclass(format('%I.%I', ${MIGRATIONS_JOURNAL.migrationsSchema}::text, ${MIGRATIONS_JOURNAL.migrationsTable}::text))::text as present
      `;
      expect(fallback?.present).toBeNull();
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});

describe("an ordinary database", () => {
  test("migrates from empty and then forward, without being refused", async () => {
    const url = await throwawayDatabase();
    const client = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await applyMigrations(client, await folderOf([first]));
      await applyMigrations(
        client,
        await folderOf([
          first,
          {
            tag: "0001_next",
            when: 2_000_000,
            sql: 'CREATE TABLE "next" ("id" text PRIMARY KEY);\n',
          },
        ]),
      );

      expect(await exists(client, "next")).toBe(true);
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
