import { createServer, type Server, type IncomingMessage } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { createSchedulerD1Fixture } from "./local-d1";
import { composeCronDependencies } from "../../../workers/cron-sync/src/composition";
import type { CronWorkerEnv } from "../../../workers/cron-sync/src/config";
import { createVerifierServer } from "../../../containers/official-link-verifier/server";
import imageWorker from "../../../workers/image-ingest/src/index";
import { handleScheduledImageIngest } from "../../../workers/image-ingest/src/scheduled";
import { runCronSync } from "../service";
import type { CronExecutionInput, CronExecutionResult } from "../types";
import type { ImageResult, WorkerEnv } from "../../images/types";
import type { Clock, TimerHandle } from "../../images/clock";
import { createImageIngestService } from "../../images/service";
import { createScheduledR2ImageStore } from "../../images/scheduled-r2-store";
import { createR2ImageStore } from "../../images/r2-store";
import { createScheduledImageRepository } from "../../db/repositories/scheduled/images";
import { createDatabase } from "../../db/client";
import { parseScheduledImageRequest } from "../../images/scheduled-codec";
import { createCronSignals } from "../signals";

export const HARNESS_SECRETS = {
  verifier: "cron-verifier-secret-canary-00000000000000000",
  scheduled: "cron-scheduled-secret-canary",
  legacy: "cron-legacy-secret-canary",
  twitch: "cron-twitch-secret-canary",
};
const jpeg = Uint8Array.from([255,216,255,224,0,4,74,70,255,192,0,17,8,0,32,0,48,3,1,17,0,2,17,1,3,17,1,255,217]);
type Point = "steam_response" | "igdb_response" | "verifier_response" | "r2_put" | "d1_bind" | "d1_create";
type Kind = "steam" | "igdb" | "links" | "images" | "r2.put.completed" | "d1.bind.attempted" | "d1.create.attempted";
export type CronHarness = {
  binding: D1Database;
  run(input?: Partial<CronExecutionInput>): Promise<CronExecutionResult>;
  events: Array<{ kind: Kind; gameId: number }>;
  pause(point: Point): { reached: Promise<void>; resume(): void };
  dispose(): Promise<void>;
  seed(gameId: number): Promise<void>;
  snapshot(): Promise<Record<string, unknown[]>>;
  counts(): Promise<Record<string, number>>;
  imageResponses: ImageResult[];
  logs: string[];
  sql: string[];
  rejectSteam: Set<string>;
  downloads: number;
  heads: number;
  elapsedMs: number;
  verifierMode: "healthy" | "unavailable" | "bad_mac" | "malformed";
  restartVerifier(): Promise<void>;
  imageRequest(request: Request): Promise<Response>;
  verifierOrigin: string;
  expireImageDeadline(): void;
  imageAuthorityLosses: () => Array<string | null>;
  verifierTargets: number;
  failPhase: "finish" | "release" | null;
  badImages: Set<string>;
};
type Options = {
  failAfter?: "d1" | "verifier" | "image";
  onResource?: (name: string, operation: "acquired" | "disposed", root: string) => void;
  manualImageClock?: boolean;
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export async function startCronHarness(options: Options = {}): Promise<CronHarness> {
  const ledger: Array<() => Promise<void>> = [];
  let root = "";
  let disposed = false;
  const track = (name: string, cleanup: () => Promise<void>) => {
    let closed = false;
    options.onResource?.(name, "acquired", root);
    ledger.push(async () => { if (closed) return; closed = true; try { await cleanup(); } finally { options.onResource?.(name, "disposed", root); } });
  };
  const pauses = new Map<Point, { reached: ReturnType<typeof deferred>; resumed: ReturnType<typeof deferred> }>();
  const gate = async (point: Point) => {
    const pause = pauses.get(point);
    if (!pause) return;
    pauses.delete(point); pause.reached.resolve(); await pause.resumed.promise;
  };
  const allResumes: Array<() => void> = [];
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    allResumes.forEach(resume => resume());
    const errors: unknown[] = [];
    for (const cleanup of [...ledger].reverse()) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Cron fixture cleanup failed");
  };
  const failAfter = (name: Options["failAfter"]) => { if (options.failAfter === name) throw new Error(`Injected failure after ${name}`); };
  try {
    const f = await createSchedulerD1Fixture({ afterPlatformOpened(resource) { root = resource.root; } });
    track("d1", () => f.dispose());
    failAfter("d1");
    const networkFetch = globalThis.fetch;
    const events: CronHarness["events"] = [];
    const imageResponses: ImageResult[] = [];
    const logs: string[] = [];
    const sql: string[] = [];
    const rejectSteam = new Set<string>();
    let currentGame = 10;
    let h = undefined as unknown as CronHarness;
    const provider = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url!, "http://fixture");
        const text = (await body(request)).toString();
        let value: unknown;
        if (url.pathname === "/steam") {
          const appId = url.searchParams.get("appids")!;
          await gate("steam_response");
          if (rejectSteam.has(appId)) { response.writeHead(503); response.end("provider-body-secret-canary"); return; }
          value = { [appId]: { success: true, data: { type: "game", steam_appid: Number(appId), name: `Fixture ${appId}` } } };
        } else if (url.pathname === "/oauth2/token") {
          value = { access_token: "access-token-secret-canary", expires_in: 3600, token_type: "bearer" };
        } else if (url.pathname === "/v4/external_games") {
          const appId = text.match(/uid\s*=\s*"(\d+)"/)?.[1];
          value = /game\s*!=/.test(text) ? [] : [{ id: Number(appId), game: 1000 + Number(appId), uid: appId, external_game_source: 1 }];
        } else if (url.pathname === "/v4/games") {
          const id = Number(text.match(/where\s+id\s*=\s*(\d+)/)?.[1]);
          await gate("igdb_response");
          value = [{ id, name: `Fixture ${id - 1000}`, summary: "A real persisted enrichment" }];
        } else if (url.pathname === "/image") {
          h.downloads++;
          if (url.searchParams.has("bad")) { response.writeHead(200, { "content-type": "image/jpeg" }); response.end("invalid image fixture"); return; }
          response.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.byteLength }); response.end(jpeg); return;
        } else if (url.pathname === "/target") { response.writeHead(200); response.end(); return; }
        else { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
      })().catch(() => { response.writeHead(500); response.end(); });
    });
    const providerOrigin = await listen(provider);
    track("provider", () => close(provider));
    let verifier: Server;
    const startVerifier = async () => {
      verifier = createVerifierServer({ secret: HARNESS_SECRETS.verifier, nowMs: Date.now, transport: {
        async verify(exactUrl) {
          // Controlled target network only. The authenticated Node server and wire client are real.
          const startedAt = new Date();
          h.verifierTargets++;
          const result = await networkFetch(`${providerOrigin}/target`);
          await gate("verifier_response");
          const finishedAt = new Date();
          return { code: "http_result", finalUrl: exactUrl, httpStatus: result.status, checkedAt: finishedAt,
            attempts: [{ method: "HEAD", url: exactUrl, resolvedAddress: "93.184.216.34", addressFamily: 4, httpStatus: result.status, startedAt, finishedAt }], redirectChain: [] };
        },
      } });
      return listen(verifier);
    };
    let verifierOrigin = await startVerifier();
    track("verifier", () => close(verifier));
    failAfter("verifier");

    const configPath = join(root, "image.json");
    await writeFile(configPath, JSON.stringify({ name: "gamehub-cron-image-fixture", compatibility_date: "2026-09-01",
      d1_databases: [{ binding: "DB", database_name: "gamehub", database_id: "00000000-0000-0000-0000-000000000000", preview_database_id: "gamehub-scheduler-fixture" }],
      r2_buckets: [{ binding: "IMAGES_BUCKET", bucket_name: "gamehub-cron-images" }] }));
    const { getPlatformProxy } = await import("wrangler");
    const imagePlatform = await getPlatformProxy<{ DB: D1Database; IMAGES_BUCKET: R2Bucket }>({ configPath, persist: { path: join(root, "state/v3") }, envFiles: [], remoteBindings: false });
    track("image-bindings", () => imagePlatform.dispose());
    const statements = new WeakMap<object, { original: D1PreparedStatement; sql: string }>();
    const wrapStatement = (original: D1PreparedStatement, query: string): D1PreparedStatement => {
      const wrapped = new Proxy(original, { get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values), query);
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      statements.set(wrapped, { original, sql: query }); return wrapped;
    };
    const imageDb = new Proxy(imagePlatform.env.DB, { get(target, key) {
      if (key === "prepare") return (query: string) => wrapStatement(target.prepare(query), query);
      if (key === "batch") return async (batch: D1PreparedStatement[]) => {
        const queries = batch.map(statement => statements.get(statement)!);
        sql.push(...queries.map(query => query.sql));
        for (const query of queries) {
          if (/^\s*(UPDATE|INSERT INTO) "game_images"/i.test(query.sql)) {
            const create = /^\s*INSERT/i.test(query.sql);
            await gate(create ? "d1_create" : "d1_bind");
            events.push({ kind: create ? "d1.create.attempted" : "d1.bind.attempted", gameId: currentGame });
          }
        }
        return target.batch(queries.map(query => query.original));
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const bucket = new Proxy(imagePlatform.env.IMAGES_BUCKET, { get(target, key) {
      if (key === "head") return async (name: string) => { h.heads++; return target.head(name); };
      if (key === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        await gate("r2_put");
        const result = await target.put(...args);
        events.push({ kind: "r2.put.completed", gameId: currentGame }); return result;
      };
      if (key === "delete") return () => { throw new Error("Scheduled artifact deletion forbidden"); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const imageEnv: WorkerEnv = { DB: imageDb, IMAGES_BUCKET: bucket, IMAGE_PUBLIC_BASE_URL: "https://images.example.test", IMAGE_INGEST_TOKEN: HARNESS_SECRETS.legacy, IMAGE_INGEST_SCHEDULED_TOKEN: HARNESS_SECRETS.scheduled };
    let imageNow = 0;
    let timerId = 0;
    const imageTimers = new Map<number, { at: number; callback: () => void }>();
    const imageSignals: ReturnType<typeof createCronSignals>[] = [];
    const imageClock: Clock = {
      now: () => imageNow,
      setTimeout(callback, delay) { const id = ++timerId; imageTimers.set(id, { at: imageNow + delay, callback }); return id as unknown as TimerHandle; },
      clearTimeout(id) { imageTimers.delete(id as unknown as number); },
    };
    const imageServer = createServer((request, response) => {
      void (async () => {
        const bytes = await body(request);
        const input = new Request(`http://image${request.url}`, { method: request.method, headers: request.headers as Record<string, string>, ...(bytes.length ? { body: bytes } : {}) });
        const output = options.manualImageClock
          ? await handleScheduledImageIngest(input, imageEnv, {} as ExecutionContext, { serviceFactory() {
            const envelope = parseScheduledImageRequest(bytes);
            const signals = createCronSignals(); imageSignals.push(signals);
            return createImageIngestService({
              repository: createScheduledImageRepository({ binding: imageDb, db: createDatabase(imageDb), authority: envelope.authority, signals }),
              r2: createScheduledR2ImageStore(createR2ImageStore(bucket, imageEnv.IMAGE_PUBLIC_BASE_URL)),
              clock: imageClock, now: () => imageNow,
              beforeImage() { if (signals.readAuthorityLoss()) throw new Error("Image authority lost"); },
            });
          } })
          : await imageWorker.fetch(input, imageEnv, {} as ExecutionContext);
        response.writeHead(output.status, Object.fromEntries(output.headers)); response.end(Buffer.from(await output.arrayBuffer()));
      })().catch(() => { response.writeHead(500); response.end(); });
    });
    const imageOrigin = await listen(imageServer);
    track("image-http", () => close(imageServer));
    failAfter("image");
    const forward = (origin: string, request: Request) => networkFetch(new Request(new URL(new URL(request.url).pathname, origin), request));
    const env = {
      DB: f.binding,
      IMAGE_INGEST: { fetch: async (request: Request) => {
        const response = await forward(imageOrigin, request);
        if (response.ok) imageResponses.push((await response.clone().json() as { result: ImageResult }).result);
        return response;
      } },
      VERIFIER_CONTAINER: { idFromName: () => "fixture", get: () => ({
        async startVerifier() { if (h.verifierMode === "unavailable") throw new Error("provider-body-secret-canary"); },
        async fetch(request: Request) {
          const response = await forward(verifierOrigin, request);
          if (h.verifierMode === "bad_mac") { const headers = new Headers(response.headers); headers.set("x-gamehub-mac", "0".repeat(64)); return new Response(await response.arrayBuffer(), { status: response.status, headers }); }
          if (h.verifierMode === "malformed") return Response.json({ raw: "provider-body-secret-canary" });
          return response;
        },
      }) },
      TWITCH_CLIENT_ID: "fixture-client", TWITCH_CLIENT_SECRET: HARNESS_SECRETS.twitch,
      VERIFIER_SERVICE_SECRET: HARNESS_SECRETS.verifier, IMAGE_INGEST_SCHEDULED_TOKEN: HARNESS_SECRETS.scheduled,
    } as unknown as CronWorkerEnv;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "store.steampowered.com") return networkFetch(`${providerOrigin}/steam${url.search}`, init);
      if (url.hostname === "id.twitch.tv") return networkFetch(`${providerOrigin}/oauth2/token`, init);
      if (url.hostname === "api.igdb.com") return networkFetch(`${providerOrigin}${url.pathname}`, init);
      if (url.hostname === "cdn.akamai.steamstatic.com") return networkFetch(`${providerOrigin}/image${h.badImages.has(url.href) ? "?bad=1" : ""}`, init);
      throw new Error("Unexpected provider destination");
    });
    track("fetch", async () => { vi.unstubAllGlobals(); });
    const log = vi.spyOn(console, "log").mockImplementation(line => { logs.push(String(line)); });
    track("logging", async () => { log.mockRestore(); });
    h = {
      binding: f.binding, events, imageResponses, logs, sql, rejectSteam, dispose,
      downloads: 0, heads: 0, elapsedMs: 0, verifierMode: "healthy",
      verifierTargets: 0,
      failPhase: null, badImages: new Set(),
      imageAuthorityLosses: () => imageSignals.map(signals => signals.readAuthorityLoss()),
      expireImageDeadline() {
        imageNow += 30_000;
        for (const [id, timer] of [...imageTimers]) if (timer.at <= imageNow) { imageTimers.delete(id); timer.callback(); }
      },
      get verifierOrigin() { return verifierOrigin; },
      async restartVerifier() { await close(verifier); verifierOrigin = await startVerifier(); },
      imageRequest: request => forward(imageOrigin, request),
      pause(point) {
        const reached = deferred(); const resumed = deferred(); pauses.set(point, { reached, resumed });
        allResumes.push(resumed.resolve); return { reached: reached.promise, resume: resumed.resolve };
      },
      snapshot: () => f.dump(),
      async counts() { const dump = await f.dump(); return Object.fromEntries(Object.entries(dump).filter(([name]) => name !== "__schema").map(([name, rows]) => [name, rows.length])); },
      async seed(id) {
        const source = `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`;
        await f.binding.prepare("INSERT INTO games(id,slug,title,cover_url) VALUES(?,?,?,?)").bind(id, `fixture-${id}`, `Fixture ${id}`, source).run();
        await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(?,'steam',?)").bind(id, String(id)).run();
        await f.binding.prepare("INSERT INTO game_images(game_id,type,source_url,source_provider) VALUES(?,'cover',?,'steam')").bind(id, source).run();
        await f.binding.prepare("INSERT INTO game_official_links(game_id,provider,link_type,url,is_official) VALUES(?,'igdb','official_website',?,1)").bind(id, `https://official.example.test/game/${id}?token=raw-url-secret-canary`).run();
        if (!(await imagePlatform.env.DB.prepare("SELECT id FROM games WHERE id=?").bind(id).first())) throw new Error("Image and Cron bindings do not share seeded D1");
      },
      async run(input = {}) {
        const execution = { executionId: crypto.randomUUID(), scheduledAt: new Date(), ...input };
        const deps = composeCronDependencies(env, execution);
        deps.elapsedMs = () => h.elapsedMs;
        if (h.failPhase === "finish") deps.state.finishAttempt = async () => { throw new Error("metadata-secret-canary"); };
        if (h.failPhase === "release") deps.lease.release = async () => { throw new Error("release-secret-canary"); };
        const compose = deps.createGameRuntime;
        deps.createGameRuntime = (candidate, authority, signals) => {
          const runtime = compose(candidate, authority, signals);
          for (const stage of ["steam", "igdb", "links", "images"] as const) {
            const execute = runtime.stages[stage].execute;
            runtime.stages[stage].execute = (async (id: never, context: { dryRun: boolean }) => {
              currentGame = candidate.gameId; events.push({ kind: stage, gameId: currentGame }); return execute(id, context);
            }) as typeof execute;
          }
          return runtime;
        };
        return runCronSync(execution, deps);
      },
    };
    await h.seed(10);
    return h;
  } catch (error) { await dispose(); throw error; }
}
