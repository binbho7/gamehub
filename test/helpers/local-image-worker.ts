import { spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import { createDatabase } from "../../lib/db/client";
import { createImageIngestRepository } from "../../lib/db/repositories/image-ingest";
import { createImageIngestService } from "../../lib/images/service";
import { createR2ImageStore } from "../../lib/images/r2-store";
import { handleImageIngest } from "../../workers/image-ingest/src/index";
import type { WorkerEnv } from "../../lib/images/types";

const DEFAULT_PORT = 8796;
const DEFAULT_TOKEN = "local-image-worker-test-token";
const DEFAULT_PERSIST_PATH = "/private/tmp/gamehub-v26-worker-test-state";
const CONFIG_PATH = fileURLToPath(new URL("../../workers/image-ingest/wrangler.jsonc", import.meta.url));
const FIXTURE_ENTRYPOINT = fileURLToPath(new URL("./image-worker-fixture.ts", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WRANGLER_CLI = fileURLToPath(new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url));

type LocalWorkerBindings = {
  DB: AnyD1Database;
  IMAGES_BUCKET: WorkerEnv["IMAGES_BUCKET"];
};

export type LocalImageWorkerSeed = (bindings: {
  db: AnyD1Database;
  bucket: WorkerEnv["IMAGES_BUCKET"];
}) => Promise<void> | void;

export type LocalImageWorkerOptions = {
  port?: number;
  persistPath?: string;
  token?: string;
  fixtureOrigin?: string;
  workingDirectory?: string;
};

export type LocalImageWorker = {
  baseUrl: string;
  token: string;
  seed(seedAdapter: LocalImageWorkerSeed): Promise<void>;
  read<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  head(key: string): Promise<unknown>;
  request(gameId: number, write: boolean): Promise<Response>;
  requestWithSource(
    gameId: number,
    write: boolean,
    fetchImpl: typeof fetch,
    counts: { r2Head: number; r2Put: number; rowsAtPut: number },
  ): Promise<Response>;
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
  try {
    const setupPlatform = await openBindings(persistPath);
    try {
      await applyLocalMigrations(setupPlatform);
    } finally {
      await setupPlatform.dispose();
    }
  } catch (error) {
    await rm(persistPath, { recursive: true, force: true });
    throw error;
  }
  const child = spawn(process.execPath, [
    WRANGLER_CLI, "dev",
    ...(options.fixtureOrigin ? [FIXTURE_ENTRYPOINT, "--var", `TEST_SOURCE_ORIGIN:${options.fixtureOrigin}`] : []),
    "--config", CONFIG_PATH,
    "--local",
    "--persist-to", persistPath,
    "--port", String(port),
    "--inspector-port", "0",
    "--log-level", "none",
    "--var", `IMAGE_INGEST_TOKEN:${token}`,
  ], {
    cwd: options.workingDirectory ?? REPOSITORY_ROOT,
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
      async requestWithSource(gameId, write, fetchImpl, counts) {
        const platform = await openBindings(persistPath);
        try {
          await applyLocalMigrations(platform);
          const database = createDatabase(platform.env.DB);
          const repository = createImageIngestRepository(database);
          const bucket = platform.env.IMAGES_BUCKET;
          const countedBucket = new Proxy(bucket, {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver);
              if (property === "head" && typeof value === "function") {
                return (...args: unknown[]) => {
                  counts.r2Head += 1;
                  return value.apply(target, args);
                };
              }
              if (property === "put" && typeof value === "function") {
                return async (...args: unknown[]) => {
                  counts.r2Put += 1;
                  const rowCount = await platform.env.DB.prepare(
                    "SELECT COUNT(*) AS count FROM game_images WHERE game_id = ?",
                  ).bind(gameId).first<{ count: number }>();
                  counts.rowsAtPut = Number(rowCount?.count ?? 0);
                  return value.apply(target, args);
                };
              }
              return value;
            },
          });
          const service = createImageIngestService({
            repository,
            r2: createR2ImageStore(countedBucket, "http://localhost:8787/images"),
            fetchImpl,
          });
          return await handleImageIngest(
            new Request(`${baseUrl}/internal/images/ingest`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ gameId, write }),
            }),
            {
              DB: platform.env.DB as WorkerEnv["DB"],
              IMAGES_BUCKET: platform.env.IMAGES_BUCKET,
              IMAGE_PUBLIC_BASE_URL: "http://localhost:8787/images",
              IMAGE_INGEST_TOKEN: token,
            },
            { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
            { serviceFactory: () => service },
          );
        } finally {
          await platform.dispose();
        }
      },
      async stop() {
        await terminate(child);
        await rm(persistPath, { recursive: true, force: true });
      },
    };
    return worker;
  } catch (error) {
    await terminate(child);
    await rm(persistPath, { recursive: true, force: true });
    throw error;
  }
}
