import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import { sha256Hex } from "../../lib/images/hash";
import { buildImageStorageKey } from "../../lib/images/storage-key";
import type { ImageResult } from "../../lib/images/types";
import { runBulkSyncBatch } from "../../lib/sync/batch";
import { formatBulkSyncResultHuman, formatBulkSyncResultJson } from "../../lib/sync/presentation";
import { verifyUrl } from "../../lib/verifiers/official-links/verifier";
import {
  composeLocalBulkSyncStages,
  createLocalBulkSyncDependencies,
  type BulkSyncTransportOverrides,
} from "../../scripts/sync-composition";
import { runBulkSyncCli } from "../../scripts/sync-games";
import { parseImageWorkerResponse } from "../../scripts/sync-image-client";
import {
  startLocalImageWorker,
  type LocalImageWorker,
} from "../helpers/local-image-worker";

const WORKER_PORT = 8787;
const WORKER_TOKEN = "v27-fixture-token";
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);
const FULLY_INGESTED_BYTES = new Uint8Array([0x50, 0x52, 0x45, 0x56, 0x49, 0x4f, 0x55, 0x53]);

export type BulkSyncHarness = {
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string[]; stderr: string[] }>;
  read(sql: string, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  snapshot(): Promise<Record<string, unknown[]>>;
  close(): Promise<void>;
  events: string[];
  imageResponses: ImageResult[];
  rejectedIgdbAppIds: Set<string>;
  mutations: { d1: number; r2Puts: number; r2Heads: number };
};

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  run(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown;
  first(...values: unknown[]): unknown;
  raw(...values: unknown[]): unknown;
};

function isMutation(sql: string): boolean {
  return /^\s*(insert|update|delete|replace)\b/i.test(sql);
}

function instrumentBinding(
  binding: AnyD1Database,
  counters: { d1: number },
): AnyD1Database {
  const wrappedTargets = new WeakMap<object, object>();
  const wrappedSql = new WeakMap<object, string>();

  const wrapStatement = (target: D1StatementLike, sql: string): D1StatementLike => {
    const wrapped = new Proxy(target, {
      get(statement, property, receiver) {
        if (property === "bind") {
          return (...args: unknown[]) => wrapStatement(
            Reflect.apply(statement.bind, statement, args) as D1StatementLike,
            sql,
          );
        }
        if (["run", "all", "first", "raw"].includes(String(property))) {
          const method = Reflect.get(statement, property, receiver);
          if (typeof method !== "function") return method;
          return (...args: unknown[]) => {
            if (isMutation(sql)) counters.d1 += 1;
            return Reflect.apply(method, statement, args);
          };
        }
        const value = Reflect.get(statement, property, receiver);
        return typeof value === "function" ? value.bind(statement) : value;
      },
    });
    wrappedTargets.set(wrapped, target);
    wrappedSql.set(wrapped, sql);
    return wrapped;
  };

  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement(
          target.prepare(sql) as unknown as D1StatementLike,
          sql,
        );
      }
      if (property === "batch") {
        return (statements: readonly object[]) => {
          for (const statement of statements) {
            const sql = wrappedSql.get(statement);
            if (sql && isMutation(sql)) counters.d1 += 1;
          }
          const originals = statements.map((statement) => wrappedTargets.get(statement) ?? statement);
          const batch = Reflect.get(target, property, receiver);
          return Reflect.apply(batch, target, [originals]);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.once("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function queryNumber(body: string, pattern: RegExp): number | null {
  const match = body.match(pattern);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function createFixtureHandler(
  events: string[],
  rejectedIgdbAppIds: Set<string>,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readBody(request);

    if (request.method === "GET" && url.pathname === "/steam") {
      const appId = url.searchParams.get("appids");
      if (
        !appId
        || !["10", "20", "30", "40", "50"].includes(appId)
        || url.searchParams.get("cc") !== "us"
        || url.searchParams.get("l") !== "english"
        || [...url.searchParams].length !== 3
      ) {
        events.push(`unexpected Steam App ID ${appId ?? "missing"}`);
        sendJson(response, 500, {});
        return;
      }
      events.push(`steam appdetails uid=${appId}`);
      sendJson(response, 200, {
        [appId]: {
          success: true,
          data: {
            type: "game",
            steam_appid: Number(appId),
            name: `Fixture ${appId}`,
            short_description: `Steam fixture summary ${appId}`,
            header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
            website: `https://steam-official.example/game/${appId}`,
          },
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/oauth2/token") {
      events.push("twitch token");
      sendJson(response, 200, {
        access_token: "v27-fixture-access-token",
        expires_in: 3600,
        token_type: "bearer",
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v4/external_games") {
      const appId = body.match(/uid\s*=\s*"([1-9]\d*)"/)?.[1] ?? null;
      if (appId === null) {
        events.push("unexpected IGDB mapping query");
        sendJson(response, 500, []);
        return;
      }
      events.push(`igdb mapping uid=${appId}`);
      if (rejectedIgdbAppIds.has(appId)) {
        sendJson(response, 503, { error: "fixture rejection" });
        return;
      }
      if (/game\s*!=/.test(body)) {
        sendJson(response, 200, []);
        return;
      }
      sendJson(response, 200, [{
        id: Number(appId),
        game: 1000 + Number(appId),
        uid: appId,
        external_game_source: 1,
      }]);
      return;
    }

    if (request.method === "POST" && url.pathname === "/v4/games") {
      const igdbId = queryNumber(body, /where\s+id\s*=\s*(\d+)/);
      if (igdbId === null) {
        events.push("unexpected IGDB game query");
        sendJson(response, 500, []);
        return;
      }
      events.push(`igdb game id=${igdbId}`);
      sendJson(response, 200, [{
        id: igdbId,
        name: `Fixture ${igdbId - 1000}`,
        summary: "IGDB fixture summary",
        websites: [{
          type: 1,
          trusted: true,
          url: `https://official.example/game/${igdbId}`,
        }],
      }]);
      return;
    }

    if (request.method === "GET" && url.pathname === "/fixture.jpg") {
      events.push("image source GET");
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": String(JPEG.byteLength),
      });
      response.end(Buffer.from(JPEG));
      return;
    }

    events.push(`unexpected route ${request.method ?? "UNKNOWN"} ${url.pathname}`);
    sendJson(response, 500, { error: "unexpected route" });
  };
}

function createFixtureTransports(
  origin: string,
  events: string[],
  imageResponses: ImageResult[],
  mutations: { r2Puts: number; r2Heads: number },
): BulkSyncTransportOverrides {
  const forward = (path: string, init?: RequestInit) => fetch(new URL(path, origin), init);
  return {
    steamFetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== "https://store.steampowered.com" || url.pathname !== "/api/appdetails") {
        throw new Error("Unexpected Steam destination");
      }
      return forward(`/steam${url.search}`, init);
    },
    authFetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== "https://id.twitch.tv" || url.pathname !== "/oauth2/token") {
        throw new Error("Unexpected Twitch destination");
      }
      return forward("/oauth2/token", init);
    },
    igdbFetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== "https://api.igdb.com" || !["/v4/external_games", "/v4/games"].includes(url.pathname)) {
        throw new Error("Unexpected IGDB destination");
      }
      return forward(url.pathname, init);
    },
    verifyBoundUrl: (exactUrl, options) => {
      const url = new URL(exactUrl);
      if (
        url.protocol !== "https:"
        || url.port !== ""
        || url.username !== ""
        || url.password !== ""
        || !["store.steampowered.com", "steam-official.example", "official.example"].includes(url.hostname)
      ) {
        throw new Error("Unexpected verification destination");
      }
      events.push(`verify ${exactUrl}`);
      return verifyUrl(exactUrl, {
        executeChain: async () => ({
          code: "http_result",
          httpStatus: 200,
          finalUrl: exactUrl,
          attempts: [],
          redirectChain: [],
          checkedAt: new Date(),
        }),
      }, options);
    },
    imageFetch: async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.href !== `http://127.0.0.1:${WORKER_PORT}/internal/images/ingest`) {
        throw new Error("Unexpected image Worker destination");
      }
      const request = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      if (typeof request !== "object" || request === null) throw new Error("Missing image Worker request");
      const record = request as Record<string, unknown>;
      if (typeof record.gameId !== "number" || typeof record.write !== "boolean") {
        throw new Error("Invalid image Worker request");
      }
      const response = await fetch(url, init);
      if (response.headers.get("x-test-runtime") !== "workerd") {
        throw new Error("Image request did not reach workerd");
      }
      mutations.r2Heads += Number(response.headers.get("x-test-r2-head") ?? 0);
      mutations.r2Puts += Number(response.headers.get("x-test-r2-put") ?? 0);
      if (response.ok) {
        const parsed = parseImageWorkerResponse(
          await response.clone().json(),
          record.gameId,
          record.write,
        );
        imageResponses.push(parsed);
      }
      return response;
    },
  };
}

async function ensureWorkerPortAvailable(): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(WORKER_PORT, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function seedExistingFixtures(worker: LocalImageWorker): Promise<void> {
  const hash = await sha256Hex(FULLY_INGESTED_BYTES);
  const key = buildImageStorageKey(hash, "image/jpeg");
  const now = Date.now();
  await worker.seed(async ({ db, bucket }) => {
    for (const [appId, gameId] of [["40", 4000], ["50", 5000]] as const) {
      const sourceUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;
      await db.prepare(
        "INSERT INTO games (id, slug, title, summary, status, cover_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(gameId, `fixture-${appId}`, `Fixture ${appId}`, `Existing ${appId}`, "released", sourceUrl, now).run();
      await db.prepare(
        "INSERT INTO game_external_ids (game_id, provider, external_id, external_url) VALUES (?, 'steam', ?, ?)",
      ).bind(gameId, appId, `https://store.steampowered.com/app/${appId}/`).run();
      await db.prepare(
        "INSERT INTO game_official_links (game_id, provider, link_type, url) VALUES (?, 'igdb', 'official_website', ?)",
      ).bind(gameId, `https://official.example/game/${1000 + Number(appId)}`).run();
    }

    const sourceUrl = "https://cdn.akamai.steamstatic.com/steam/apps/50/header.jpg";
    const storageUrl = `http://localhost:8787/images/${key}`;
    await db.prepare(`
      INSERT INTO game_images (
        id, game_id, type, source_url, source_provider, storage_url, storage_key,
        content_hash, mime_type, file_size, width, height, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      5050, 5000, "cover", sourceUrl, "steam", storageUrl, key,
      hash, "image/jpeg", FULLY_INGESTED_BYTES.byteLength, 48, 32, 0, now, now,
    ).run();
    await bucket.put(key, FULLY_INGESTED_BYTES, {
      sha256: hash,
      httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { sha256: hash, size: String(FULLY_INGESTED_BYTES.byteLength) },
    });
  });
}

export async function startBulkSyncHarness(): Promise<BulkSyncHarness> {
  const root = await mkdtemp(join(tmpdir(), "gamehub-v27-sync-"));
  const persistPath = join(root, "state");
  const events: string[] = [];
  const imageResponses: ImageResult[] = [];
  const rejectedIgdbAppIds = new Set<string>();
  const mutations = { d1: 0, r2Puts: 0, r2Heads: 0 };
  let worker: LocalImageWorker | undefined;
  let fixture: Server | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await worker?.stop();
    } finally {
      try {
        await closeServer(fixture);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };

  try {
    await ensureWorkerPortAvailable();
    fixture = createServer(createFixtureHandler(events, rejectedIgdbAppIds));
    await new Promise<void>((resolve, reject) => {
      fixture!.once("error", reject);
      fixture!.listen(0, "127.0.0.1", resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("Fixture startup failed");
    const fixtureOrigin = `http://127.0.0.1:${address.port}`;
    worker = await startLocalImageWorker({
      port: WORKER_PORT,
      persistPath,
      token: WORKER_TOKEN,
      fixtureOrigin,
    });
    const readiness = await fetch(`${worker.baseUrl}/internal/images/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: 10, write: false }),
      redirect: "error",
    });
    if (readiness.status !== 401 || readiness.headers.get("x-test-runtime") !== "workerd") {
      throw new Error("Owned fixture Worker was not ready");
    }
    await seedExistingFixtures(worker);

    const read = (sql: string, ...params: unknown[]) => worker!.read(sql, ...params);
    return {
      events,
      imageResponses,
      rejectedIgdbAppIds,
      mutations,
      close,
      read,
      snapshot: async () => {
        const tables = await read(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
        );
        const snapshot: Record<string, unknown[]> = {};
        for (const row of tables) {
          const name = String(row.name);
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Unexpected table name");
          snapshot[name] = await read(`SELECT * FROM "${name}" ORDER BY rowid`);
        }
        return snapshot;
      },
      async run(argv) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const env = {
          TWITCH_CLIENT_ID: "v27-fixture-client",
          TWITCH_CLIENT_SECRET: "v27-fixture-secret",
          IMAGE_INGEST_TOKEN: WORKER_TOKEN,
        };
        const exitCode = await runBulkSyncCli(argv, {
          readFile: readFileSync,
          env,
          runBatch: runBulkSyncBatch,
          formatHuman: formatBulkSyncResultHuman,
          formatJson: formatBulkSyncResultJson,
          stdout: (text) => { stdout.push(text); },
          stderr: (text) => { stderr.push(text); },
          createDependencies: (config) => createLocalBulkSyncDependencies(config, {
            acquire: async () => {
              const { getPlatformProxy } = await import("wrangler");
              const platform = await getPlatformProxy<{ DB: AnyD1Database }>({
                configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
                persist: { path: join(persistPath, "v3") },
                remoteBindings: false,
                envFiles: [],
              });
              return {
                env: { DB: instrumentBinding(platform.env.DB, mutations) },
                dispose: () => platform.dispose(),
              };
            },
            compose: (binding, config) => composeLocalBulkSyncStages(
              binding,
              config,
              createFixtureTransports(fixtureOrigin, events, imageResponses, mutations),
            ),
          }),
        });
        return { exitCode, stdout, stderr };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
