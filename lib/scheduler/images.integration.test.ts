import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import { createScheduledImageRepository } from "../db/repositories/scheduled/images";
import { createCronSignals } from "./signals";
import { createImageIngestService } from "../images/service";
import { createR2ImageStore } from "../images/r2-store";
import { createScheduledImageClient } from "../images/scheduled-client";
import type { Clock, TimerHandle } from "../images/clock";
import imageWorker from "../../workers/image-ingest/src/index";

const source = "https://cdn.akamai.steamstatic.com/steam/apps/9/header.jpg";
const jpeg = Uint8Array.from([255,216,255,224,0,4,74,70,255,192,0,17,8,0,32,0,48,3,1,17,0,2,17,1,3,17,1,255,217]);
describe("scheduled image real R2 then fenced D1 publication", () => {
  let f: SchedulerD1Fixture;
  let mf: Miniflare;
  let bucket: R2Bucket;
  beforeAll(async () => {
    f = await createSchedulerD1Fixture();
    mf = new Miniflare(convertV4MiniflareOptions({ cf: false, modules: true, script: "export default {fetch(){return new Response('ok')}}", compatibilityDate: "2026-09-01", r2Buckets: ["IMAGES"] }));
    bucket = await mf.getR2Bucket("IMAGES") as unknown as R2Bucket;
  }, 30_000);
  afterAll(async () => { await mf?.dispose(); await f?.dispose(); });
  beforeEach(async () => {
    await f.binding.prepare("DELETE FROM games").run();
    await f.binding.prepare("DELETE FROM cron_sync_lease").run();
    await f.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
    await f.binding.prepare("INSERT INTO games(id,slug,title,cover_url) VALUES(9,'g9','Game',?)").bind(source).run();
    const objects = await bucket.list();
    for (const object of objects.objects) await bucket.delete(object.key);
  });
  it.each([false, true])("runs the actual authenticated route and stops admission after authority loss=%s", async loseAuthority => {
    await f.binding.prepare("INSERT INTO game_images(id,game_id,type,source_url,source_provider) VALUES(1,9,'cover',?,'steam'),(2,9,'screenshot',?,'steam')").bind(source, source + "?second").run();
    const acquired = await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000);
    if (acquired.status !== "acquired") throw new Error("lease missing");
    const signals = createCronSignals();
    let downloads = 0;
    const wrappedBucket = new Proxy(bucket, { get(target, key) {
      if (key === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        const result = await target.put(...args);
        if (loseAuthority) {
          await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
          await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000);
        }
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    vi.stubGlobal("fetch", async () => { downloads++; return new Response(jpeg, { headers: { "content-type": "image/jpeg" } }); });
    try {
      const client = createScheduledImageClient({ token: "scheduled", authority: { ...acquired.lease, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER }, signals, newRequestId: () => crypto.randomUUID(), binding: { fetch: request => imageWorker.fetch(request, { DB: f.binding, IMAGES_BUCKET: wrappedBucket, IMAGE_PUBLIC_BASE_URL: "https://images.example.test", IMAGE_INGEST_TOKEN: "legacy", IMAGE_INGEST_SCHEDULED_TOKEN: "scheduled" }, {} as ExecutionContext) } });
      const result = await client.ingest(9, { write: true });
      expect(result.images.map(image => image.outcome)).toEqual(loseAuthority ? ["d1_write_failed"] : ["ingested", "deduplicated"]);
      expect(downloads).toBe(loseAuthority ? 1 : 2);
      expect(signals.readAuthorityLoss()).toBe(loseAuthority ? "fence_lost" : null);
      expect(signals.readUnsettledImageWork()).toEqual(loseAuthority ? ["image_mutation_unknown"] : []);
      const rows = (await f.binding.prepare("SELECT storage_key FROM game_images ORDER BY id").all()).results;
      expect(rows.filter(row => row.storage_key !== null)).toHaveLength(loseAuthority ? 0 : 2);
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(["bind", "create"])("rejects late %s after native deadline response and B acquisition", async operation => {
    if (operation === "bind") await f.binding.prepare("INSERT INTO game_images(id,game_id,type,source_url,source_provider) VALUES(1,9,'cover',?,'steam')").bind(source).run();
    const acquired = await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000);
    if (acquired.status !== "acquired") throw new Error("lease missing");
    const serverSignals = createCronSignals();
    const clientSignals = createCronSignals();
    const events: string[] = [];
    let reached!: () => void;
    let resume!: () => void;
    let settled!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const held = new Promise<void>(resolve => { resume = resolve; });
    const lateFinished = new Promise<void>(resolve => { settled = resolve; });
    const binding = new Proxy(f.binding, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        events.push(`d1.${operation}`); reached(); await held;
        try { return await target.batch(statements); } finally { settled(); }
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const repository = createScheduledImageRepository({ binding, db: f.db, authority: acquired.lease, signals: serverSignals });
    let now = 0;
    let timerId = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const clock: Clock = { now: () => now, setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: now + delay, callback }); return id as unknown as TimerHandle; }, clearTimeout(id) { timers.delete(id as unknown as number); } };
    const realR2 = createR2ImageStore(bucket, "https://images.example.test");
    const service = createImageIngestService({ repository, r2: { ...realR2, async ensureObject(input, context) { const result = await realR2.ensureObject(input, context); events.push("r2.complete"); return result; } }, now: () => now, clock, fetchImpl: async () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }) });
    let completions = 0;
    const client = createScheduledImageClient({ token: "scheduled", authority: acquired.lease, signals: clientSignals, newRequestId: () => "11111111-1111-4111-8111-111111111111", binding: { fetch: async () => {
      const result = await service.ingest(9, { write: true }); completions++;
      return Response.json({ version: 1, requestId: "11111111-1111-4111-8111-111111111111", authorityStatus: serverSignals.readAuthorityLoss() ?? "not_observed_lost", result });
    } } });
    const pending = client.ingest(9, { write: true });
    await paused;
    expect(events).toEqual(["r2.complete", `d1.${operation}`]);
    expect((await bucket.list()).objects).toHaveLength(1);
    now = 30_000;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    const result = await pending;
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ outcome: "deadline", error: { stage: "d1", code: "image_deadline" }, attempts: [{ errorCode: "image_deadline" }] });
    expect(clientSignals.readUnsettledImageWork()).toEqual(["image_deadline"]);
    await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
    expect((await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000)).status).toBe("acquired");
    const before = await f.dump();
    resume(); await lateFinished;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(serverSignals.readAuthorityLoss()).toBe("fence_lost");
    expect(clientSignals.readUnsettledImageWork()).toEqual(["image_deadline"]);
    expect(await f.dump()).toEqual(before);
    expect(completions).toBe(1);
  });
});
