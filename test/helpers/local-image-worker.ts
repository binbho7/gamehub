import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { R2Bucket } from "@cloudflare/workers-types";

const DEFAULT_PORT = 8796;
const DEFAULT_TOKEN = "local-image-worker-test-token";
const DEFAULT_PERSIST_PATH = "/private/tmp/gamehub-v26-worker-test-state";
const CONFIG_PATH = fileURLToPath(new URL("../../workers/image-ingest/wrangler.jsonc", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

type LocalWorkerBindings = {
  DB: AnyD1Database;
  IMAGES_BUCKET: R2Bucket;
};

export type LocalImageWorkerSeed = (bindings: {
  db: AnyD1Database;
  bucket: R2Bucket;
}) => Promise<void> | void;

export type LocalImageWorkerOptions = {
  port?: number;
  persistPath?: string;
  token?: string;
};

export type LocalImageWorker = {
  baseUrl: string;
  token: string;
  seed(seedAdapter: LocalImageWorkerSeed): Promise<void>;
  read<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  head(key: string): Promise<unknown>;
  request(gameId: number, write: boolean): Promise<Response>;
  stop(): Promise<void>;
};

type Platform = {
  env: LocalWorkerBindings;
  dispose(): Promise<void>;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isConnectionFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && /fetch failed|econnrefused|enotfound/i.test(error.message));
}

async function openBindings(persistPath: string): Promise<Platform> {
  const { getPlatformProxy } = await import("wrangler");
  return getPlatformProxy<LocalWorkerBindings>({
    configPath: CONFIG_PATH,
    // `wrangler dev --persist-to P` stores Miniflare resources under P/v3.
    // Match that layout so the seed/read adapter observes the same bindings
    // as the Worker process rather than creating a parallel local database.
    persist: { path: `${persistPath}/v3` },
    remoteBindings: false,
    envFiles: [],
  });
}

async function applyLocalMigrations(platform: Platform): Promise<void> {
  const table = await platform.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_images'",
  ).all<{ name: string }>();
  if (table.results.length > 0) return;

  const migrationDirectory = new URL("../../drizzle/", import.meta.url);
  const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const migration = await readFile(new URL(file, migrationDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql) await platform.env.DB.prepare(sql).run();
    }
  }
}

function rejectMutatingRead(sql: string): void {
  if (/^\s*(insert|update|delete|replace|create|drop|alter|vacuum|reindex|attach|detach)\b/i.test(sql)) {
    throw new Error("Local image Worker read adapter only accepts read-only SQL");
  }
}

function commandOutput(child: ChildProcess): string[] {
  const output: string[] = [];
  const collect = (chunk: Buffer): void => {
    if (output.length < 20) output.push(chunk.toString().slice(0, 2000));
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return output;
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export async function startLocalImageWorker(options: LocalImageWorkerOptions = {}): Promise<LocalImageWorker> {
  const port = options.port ?? DEFAULT_PORT;
  const token = options.token ?? DEFAULT_TOKEN;
  const persistPath = options.persistPath ?? DEFAULT_PERSIST_PATH;
  const baseUrl = `http://127.0.0.1:${port}`;
  const setupPlatform = await openBindings(persistPath);
  try {
    await applyLocalMigrations(setupPlatform);
  } finally {
    await setupPlatform.dispose();
  }
  const child = spawn("npx", [
    "wrangler", "dev",
    "--config", CONFIG_PATH,
    "--local",
    "--persist-to", persistPath,
    "--port", String(port),
    "--inspector-port", "0",
    "--log-level", "none",
    "--var", `IMAGE_INGEST_TOKEN:${token}`,
  ], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      IMAGE_INGEST_TOKEN: token,
      WRANGLER_LOG_PATH: "/private/tmp/gamehub-v26-wrangler-test.log",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = commandOutput(child);
  let started = false;
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Local image Worker exited during startup${output.length > 0 ? `: ${output.join(" ")}` : ""}`);
      }
      try {
        await fetch(`${baseUrl}/`);
        started = true;
        break;
      } catch (error) {
        if (!isConnectionFailure(error)) throw error;
      }
      await sleep(100);
    }
    if (!started) throw new Error("Local image Worker did not start within 15 seconds");

    const worker: LocalImageWorker = {
      baseUrl,
      token,
      async seed(seedAdapter) {
        const platform = await openBindings(persistPath);
        try {
          await applyLocalMigrations(platform);
          await seedAdapter({ db: platform.env.DB, bucket: platform.env.IMAGES_BUCKET });
        } finally {
          await platform.dispose();
        }
      },
      async read<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
        rejectMutatingRead(sql);
        const platform = await openBindings(persistPath);
        try {
          return (await platform.env.DB.prepare(sql).bind(...params).all<T>()).results;
        } finally {
          await platform.dispose();
        }
      },
      async head(key: string): Promise<unknown> {
        const platform = await openBindings(persistPath);
        try {
          const object = await platform.env.IMAGES_BUCKET.head(key);
          if (object === null) return { exists: false };
          return {
            exists: true,
            size: object.size,
            contentType: object.httpMetadata?.contentType ?? null,
            cacheControl: object.httpMetadata?.cacheControl ?? null,
            customMetadata: object.customMetadata ?? {},
          };
        } finally {
          await platform.dispose();
        }
      },
      async request(gameId, write) {
        return fetch(`${baseUrl}/internal/images/ingest`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ gameId, write }),
        });
      },
      async stop() {
        await terminate(child);
      },
    };
    return worker;
  } catch (error) {
    await terminate(child);
    await rm(persistPath, { recursive: true, force: true });
    throw error;
  }
}
