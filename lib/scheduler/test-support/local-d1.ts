import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { GetPlatformProxyOptions } from "wrangler";
import { createDatabase, type GameHubDatabase } from "../../db/client";

export type SchedulerD1Fixture = {
  binding: D1Database;
  db: GameHubDatabase;
  dispose(): Promise<void>;
  applyV28(): Promise<void>;
  dump(): Promise<Record<string, unknown[]>>;
};

type SchedulerD1FixtureOptions = {
  migrationCount?: 4 | 5;
};

type LocalPlatform = {
  env: { DB: D1Database };
  dispose(): Promise<void> | void;
};

type Cleanup = () => Promise<void> | void;

function once(cleanup: Cleanup): () => Promise<void> {
  let complete = false;
  return async () => {
    if (complete) return;
    complete = true;
    await cleanup();
  };
}

function quotedIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function migrationFiles() {
  const directory = new URL("../../../drizzle/", import.meta.url);
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return { directory, files };
}

async function applyMigration(binding: D1Database, migrationUrl: URL) {
  const migration = await readFile(migrationUrl, "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) await binding.prepare(sql).run();
  }
}

async function rows<T extends Record<string, unknown>>(binding: D1Database, sql: string) {
  return (await binding.prepare(sql).all<T>()).results;
}

async function dumpDatabase(binding: D1Database): Promise<Record<string, unknown[]>> {
  const schema = await rows(binding, `
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index')
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%'
    ORDER BY type, name
  `);
  const tables = schema
    .filter((entry) => entry.type === "table")
    .map((entry) => String(entry.name));
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    const tableIdentifier = quotedIdentifier(table);
    const columns = await rows<{ name: string; pk: number }>(
      binding,
      `PRAGMA table_info(${tableIdentifier})`,
    );
    const primaryKey = columns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => quotedIdentifier(column.name));
    const fallbackOrder = columns.map((column) => quotedIdentifier(column.name));
    const order = primaryKey.length > 0 ? primaryKey : fallbackOrder;
    result[table] = await rows(
      binding,
      `SELECT * FROM ${tableIdentifier}${order.length > 0 ? ` ORDER BY ${order.join(", ")}` : ""}`,
    );
  }
  result.__schema = schema;
  return result;
}

export async function createSchedulerD1Fixture(
  { migrationCount = 5 }: SchedulerD1FixtureOptions = {},
): Promise<SchedulerD1Fixture> {
  const cleanups: Cleanup[] = [];
  const track = (cleanup: Cleanup) => {
    const tracked = once(cleanup);
    cleanups.push(tracked);
    return tracked;
  };
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "scheduler D1 fixture cleanup failed");
  };

  try {
    const persistenceRoot = await mkdtemp(join(tmpdir(), "gamehub-cron-d1-"));
    track(() => rm(persistenceRoot, { recursive: true, force: true }));

    const { getPlatformProxy } = await import("wrangler");
    const options = {
      configPath: fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url)),
      persist: { path: persistenceRoot },
      remoteBindings: false,
      envFiles: [],
    } satisfies GetPlatformProxyOptions;
    const migrationPlatform = await getPlatformProxy<{ DB: D1Database }>(options) as LocalPlatform;
    const closeMigrationPlatform = track(() => migrationPlatform.dispose());

    const { directory, files } = await migrationFiles();
    if (files.length !== 5 || files[4] !== "0004_cron_sync_fencing.sql") {
      throw new Error("scheduler fixture requires the exact five-migration V2.8 schema");
    }
    let appliedCount = 0;
    for (const file of files.slice(0, migrationCount)) {
      await applyMigration(migrationPlatform.env.DB, new URL(file, directory));
      appliedCount += 1;
    }
    await closeMigrationPlatform();

    // Re-open the same isolated persistence root so callers exercise durable
    // local D1 state rather than an in-memory handle left over from migration.
    const platform = await getPlatformProxy<{ DB: D1Database }>(options) as LocalPlatform;
    track(() => platform.dispose());

    return {
      binding: platform.env.DB,
      db: createDatabase(platform.env.DB as AnyD1Database),
      dispose,
      async applyV28() {
        if (appliedCount >= 5) return;
        await applyMigration(platform.env.DB, new URL(files[4]!, directory));
        appliedCount = 5;
      },
      dump: () => dumpDatabase(platform.env.DB),
    };
  } catch (error) {
    try {
      await dispose();
    } catch {
      // Startup remains the primary test-fixture failure.
    }
    throw error;
  }
}
