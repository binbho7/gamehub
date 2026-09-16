import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

type LocalPlatform = {
  env: { DB: D1Database };
  dispose(): Promise<void> | void;
};

type SchedulerD1FixtureOptions = {
  migrationCount?: 4 | 5;
  afterPlatformOpened?: (resource: { root: string }) => Promise<void> | void;
  platformFactory?: (options: GetPlatformProxyOptions) => Promise<LocalPlatform>;
};

type Cleanup = () => Promise<void> | void;
type ActivePlatform = {
  platform: LocalPlatform;
  db: GameHubDatabase;
  close(): Promise<void>;
};

const WRANGLER_CLI = fileURLToPath(
  new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

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
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  if (files.length !== 5 || files[4] !== "0004_cron_sync_fencing.sql") {
    throw new Error("scheduler fixture requires the exact five-migration V2.8 schema");
  }
  return { directory, files };
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
  const tables = schema.filter((entry) => entry.type === "table").map((entry) => String(entry.name));
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

async function runWranglerMigrations(options: {
  projectRoot: string;
  configPath: string;
  persistencePath: string;
  logPath: string;
}) {
  const output: string[] = [];
  const child = spawn(process.execPath, [
    WRANGLER_CLI,
    "d1", "migrations", "apply", "DB",
    "--local", "--persist-to", options.persistencePath,
    "--config", options.configPath,
  ], {
    cwd: options.projectRoot,
    env: { ...process.env, CI: "1", WRANGLER_LOG_PATH: options.logPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`local Wrangler D1 migration failed (${exitCode}): ${output.join("").slice(-4000)}`);
  }
}

export async function createSchedulerD1Fixture(
  { migrationCount = 5, afterPlatformOpened, platformFactory }: SchedulerD1FixtureOptions = {},
): Promise<SchedulerD1Fixture> {
  const cleanups: Cleanup[] = [];
  const track = (cleanup: Cleanup) => {
    const tracked = once(cleanup);
    cleanups.push(tracked);
    return tracked;
  };
  let disposed = false;
  let active: ActivePlatform | undefined;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    active = undefined;
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
    const root = await mkdtemp(join(tmpdir(), "gamehub-cron-d1-"));
    track(() => rm(root, { recursive: true, force: true }));
    const projectRoot = join(root, "project");
    const migrationsPath = join(projectRoot, "drizzle");
    const persistencePath = join(root, "state");
    const configPath = join(projectRoot, "wrangler.jsonc");
    const logPath = join(root, "wrangler.log");
    await mkdir(migrationsPath, { recursive: true });
    const { directory, files } = await migrationFiles();
    const copyMigrations = async (count: 4 | 5) => {
      for (const file of files.slice(0, count)) {
        await copyFile(new URL(file, directory), join(migrationsPath, file));
      }
    };
    await copyMigrations(migrationCount);
    await writeFile(configPath, JSON.stringify({
      $schema: fileURLToPath(new URL("../../../node_modules/wrangler/config-schema.json", import.meta.url)),
      name: "gamehub-scheduler-fixture",
      compatibility_date: "2026-09-01",
      d1_databases: [{
        binding: "DB",
        database_name: "gamehub",
        database_id: "00000000-0000-0000-0000-000000000000",
        preview_database_id: "gamehub-scheduler-fixture",
        migrations_dir: "drizzle",
      }],
    }, null, 2));

    const runMigrations = () => runWranglerMigrations({ projectRoot, configPath, persistencePath, logPath });
    await runMigrations();
    const proxyOptions = {
      configPath,
      persist: { path: join(persistencePath, "v3") },
      remoteBindings: false,
      envFiles: [],
    } satisfies GetPlatformProxyOptions;
    const openPlatform = platformFactory ?? (async (options: GetPlatformProxyOptions) => {
      const { getPlatformProxy } = await import("wrangler");
      return getPlatformProxy<{ DB: D1Database }>(options) as Promise<LocalPlatform>;
    });
    const acquirePlatform = async () => {
      const platform = await openPlatform(proxyOptions);
      const close = track(() => platform.dispose());
      active = { platform, db: createDatabase(platform.env.DB as AnyD1Database), close };
      await afterPlatformOpened?.({ root });
    };
    await acquirePlatform();

    const requireActive = () => {
      if (disposed || !active) throw new Error("scheduler D1 fixture is not active");
      return active;
    };
    return {
      get binding() { return requireActive().platform.env.DB; },
      get db() { return requireActive().db; },
      dispose,
      async applyV28() {
        const previous = requireActive();
        active = undefined;
        await previous.close();
        await copyMigrations(5);
        await runMigrations();
        await acquirePlatform();
      },
      dump: () => dumpDatabase(requireActive().platform.env.DB),
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
