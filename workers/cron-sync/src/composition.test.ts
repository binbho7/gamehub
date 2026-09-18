import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "../../../lib/scheduler/test-support/local-d1";
import { createCronSignals } from "../../../lib/scheduler/signals";
import { composeCronDependencies } from "./composition";
import type { CronWorkerEnv } from "./config";
import cronWorker from "./index";

// Node cannot instantiate the Cloudflare-only base class; no application port is replaced.
vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
let f: SchedulerD1Fixture;
beforeAll(async () => { f = await createSchedulerD1Fixture(); }, 30_000);
afterAll(async () => { await f?.dispose(); });
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await f.binding.prepare("DELETE FROM games").run();
  await f.binding.prepare("UPDATE cron_sync_lease SET lease_owner_token=NULL,lease_expires_at=0").run();
  await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(8,'g8','Curated')").run();
  await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(8,'steam','80')").run();
});

function env(binding = f.binding): CronWorkerEnv {
  return { DB: binding,
    IMAGE_INGEST: { fetch: async () => { throw new Error("Unexpected image request"); }, connect() { throw new Error("Unexpected connect"); } },
    VERIFIER_CONTAINER: new Proxy({} as CronWorkerEnv["VERIFIER_CONTAINER"], { get() { return () => { throw new Error("Unexpected container request"); }; } }),
    TWITCH_CLIENT_ID: "client", TWITCH_CLIENT_SECRET: "twitch-secret",
    VERIFIER_SERVICE_SECRET: "verifier-secret", IMAGE_INGEST_SCHEDULED_TOKEN: "scheduled-secret" };
}
async function runtime(binding = f.binding) {
  const deps = composeCronDependencies(env(binding), { executionId: "run", scheduledAt: new Date() });
  const acquired = await deps.lease.acquire(deps.newOwnerToken(), 1_500_000);
  if (acquired.status !== "acquired") throw new Error("lease unavailable");
  const signals = createCronSignals();
  return { deps, authority: acquired.lease, signals, runtime: deps.createGameRuntime({ gameId: 8, appId: "80" }, acquired.lease, signals) };
}

function observeBatch(before: (statements: D1PreparedStatement[]) => void, after?: () => Promise<void>): D1Database {
  return new Proxy(f.binding, { get(target, key) {
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      before(statements);
      const result = await target.batch(statements);
      await after?.();
      return result;
    };
    const member = Reflect.get(target, key);
    return typeof member === "function" ? member.bind(target) : member;
  } });
}

it("prevents provider work on lost authority before every stage", async () => {
  let network = 0;
  vi.stubGlobal("fetch", async () => { network++; throw new Error("credential-canary"); });
  const r = await runtime();
  await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
  for (const name of ["steam", "igdb", "links", "images"] as const) {
    const stage = r.runtime.stages[name];
    await expect(stage.execute((name === "steam" ? "80" : 8) as never, { dryRun: false })).rejects.toBeDefined();
  }
  expect(network).toBe(0);
  expect(r.signals.readAuthorityLoss()).toBe("lease_lost");
});

it.each(["existing", "blocked"])("latches a late IGDB %s plan that never writes", async mode => {
  let request = 0;
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    if (String(url).includes("oauth2")) return Response.json({ access_token: "access-canary", expires_in: 3600, token_type: "bearer" });
    request++;
    if (request === 1) return Response.json([{ id: 1, game: 800, uid: "80", external_game_source: 1 }]);
    if (request === 2) return Response.json([]);
    await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
    return Response.json([{ id: 800, name: "Game" }]);
  });
  const batches: number[] = [];
  const r = await runtime(observeBatch(statements => batches.push(statements.length)));
  await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(8,'igdb',?1)").bind(mode === "existing" ? "800" : "801").run();
  await expect(r.runtime.stages.igdb.execute(8, { dryRun: false })).rejects.toBeDefined();
  expect(request).toBe(3);
  // Both native branches avoid applyPlan: only the final pair of fence assertions runs.
  expect(batches).toEqual([2]);
  expect(r.signals.readAuthorityLoss()).toBe("fence_lost");
  expect((await f.binding.prepare("SELECT external_id FROM game_external_ids WHERE provider='igdb'").first())?.external_id).toBe(mode === "existing" ? "800" : "801");
});

it("rejects a successful Steam no-op whose persisted read returns after lease expiry", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ "80": { success: true, data: { type: "game", steam_appid: 80, name: "Game" } } }));
  const first = await runtime();
  await first.runtime.stages.steam.execute("80", { dryRun: false });
  await first.deps.lease.release(first.authority);
  let batches = 0;
  const binding = observeBatch(() => { batches++; }, async () => {
    // Expire just after the native empty-plan transaction committed. The later
    // persisted snapshot is a read and cannot itself latch this authority loss.
    if (batches === 1) await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
  });
  const second = await runtime(binding);
  await expect(second.runtime.stages.steam.execute("80", { dryRun: false })).rejects.toMatchObject({ code: "write_conflict" });
  expect(batches).toBe(2);
  expect(second.signals.readAuthorityLoss()).toBe("fence_lost");
});

it("latches authority loss after a late native Steam failure", async () => {
  vi.stubGlobal("fetch", async () => {
    await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
    throw new Error("owner-token-and-credential-canary");
  });
  const r = await runtime();
  await expect(r.runtime.stages.steam.execute("80", { dryRun: false })).rejects.toMatchObject({ code: "write_conflict" });
  expect(r.signals.readAuthorityLoss()).toBe("fence_lost");
});

it("blocks unsettled delivery and cross-candidate arguments before network or writes", async () => {
  let network = 0;
  vi.stubGlobal("fetch", async () => { network++; throw new Error("should not fetch"); });
  const r = await runtime();
  await expect(r.runtime.stages.steam.execute("81", { dryRun: false })).rejects.toBeDefined();
  await expect(r.runtime.stages.igdb.execute(9, { dryRun: false })).rejects.toBeDefined();
  r.signals.markUnsettled("image_delivery_unknown");
  await expect(r.runtime.stages.steam.execute("80", { dryRun: false })).rejects.toBeDefined();
  expect(network).toBe(0);
});

it("logs Steam failures with the App ID and stage code when the pipeline has no canonical game ID", async () => {
  vi.stubGlobal("fetch", async () => { throw new Error("credential-canary"); });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await cronWorker.scheduled({ scheduledTime: 0 } as ScheduledController, env(), {} as ExecutionContext);
    const events = log.mock.calls.map(([line]) => JSON.parse(line));
    const finished = events.find(event => event.event === "game_finished");
    expect(finished).toMatchObject({ appId: "80", status: "failed", stage: "steam", code: "network_error" });
    expect(finished).not.toHaveProperty("gameId");
    expect(JSON.stringify(events)).not.toMatch(/credential-canary|ownerToken/);
  } finally { log.mockRestore(); }
});

it("emits verifier_unavailable when the remote verifier produces a branded service failure", async () => {
  let igdbRequest = 0;
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    if (String(url).includes("steampowered")) return Response.json({ "80": { success: true, data: { type: "game", steam_appid: 80, name: "Game" } } });
    if (String(url).includes("oauth2")) return Response.json({ access_token: "access-canary", expires_in: 3600, token_type: "bearer" });
    igdbRequest++;
    if (igdbRequest === 1) return Response.json([{ id: 1, game: 800, uid: "80", external_game_source: 1 }]);
    if (igdbRequest === 2) return Response.json([]);
    return Response.json([{ id: 800, name: "Game" }]);
  });
  await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(8,'igdb','800')").run();
  await f.binding.prepare("INSERT INTO game_official_links(game_id,provider,link_type,url,is_official,verification_status) VALUES(8,'igdb','official_website','https://official.example.com/',1,'unverified')").run();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await cronWorker.scheduled({ scheduledTime: 0 } as ScheduledController, env(), {} as ExecutionContext);
    const events = log.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.find(event => event.event === "game_finished")).toMatchObject({ appId: "80", gameId: 8,
      status: "failed", stage: "links", code: "verifier_service_unavailable" });
    expect(events.filter(event => event.event === "verifier_unavailable")).toEqual([
      expect.objectContaining({ event: "verifier_unavailable", code: "verifier_service_unavailable" }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/canary|ownerToken|Unexpected container|https?:/);
  } finally { log.mockRestore(); }
});
