import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import { createScheduledImageRepository } from "../db/repositories/scheduled/images";
import { createCronSignals } from "./signals";
import { createImageIngestService } from "../images/service";
import { createR2ImageStore } from "../images/r2-store";
import { createScheduledR2ImageStore } from "../images/scheduled-r2-store";
import { sha256Hex } from "../images/hash";
import { buildImageStorageKey } from "../images/storage-key";
import imageWorker from "../../workers/image-ingest/src/index";
import { SCHEDULED_IMAGE_PATH } from "../images/scheduled-codec";

const source = "https://cdn.akamai.steamstatic.com/steam/apps/9/header.jpg";
const jpeg = Uint8Array.from([255,216,255,224,0,4,74,70,255,192,0,17,8,0,32,0,48,3,1,17,0,2,17,1,3,17,1,255,217]);
const newerJpeg = new Uint8Array([...jpeg, 0]);
const publicUrl = "https://images.example.test";
const cacheControl = "public, max-age=31536000, immutable";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("scheduled artifact immutability on local R2 and D1", () => {
  let f: SchedulerD1Fixture;
  let mf: Miniflare;
  let bucket: R2Bucket;
  let events: string[];
  beforeAll(async () => { f = await createSchedulerD1Fixture(); }, 30_000);
  afterAll(async () => { await f?.dispose(); });
  beforeEach(async () => {
    await f.binding.prepare("DELETE FROM games").run();
    await f.binding.prepare("DELETE FROM cron_sync_lease").run();
    await f.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
    await f.binding.prepare("INSERT INTO games(id,slug,title,cover_url) VALUES(9,'g9','Game',?)").bind(source).run();
    mf = new Miniflare(convertV4MiniflareOptions({ cf: false, modules: true, script: "export default {fetch(){return new Response('ok')}}", compatibilityDate: "2026-09-01", r2Buckets: ["IMAGES"] }));
    const realBucket = await mf.getR2Bucket("IMAGES") as unknown as R2Bucket;
    events = [];
    bucket = new Proxy(realBucket, { get(target, key) {
      if (key === "delete") return async () => { events.push("r2.delete"); throw new Error("artifact deletion forbidden"); };
      if (key === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        events.push("r2.put.dispatched");
        const result = await target.put(...args);
        events.push("r2.put.completed");
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await mf?.dispose();
    expect(events).not.toContain("r2.delete");
  });

  async function request(bytes = jpeg) {
    const hash = await sha256Hex(bytes);
    return { key: buildImageStorageKey(hash, "image/jpeg"), bytes, hash, mimeType: "image/jpeg", size: bytes.length };
  }
  function store(target = bucket) { return createScheduledR2ImageStore(createR2ImageStore(target, publicUrl)); }
  async function acquire() {
    const result = await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000);
    if (result.status !== "acquired") throw new Error("lease unavailable");
    return result.lease;
  }
  async function objectSnapshot(key: string) {
    const object = await bucket.get(key);
    if (!object) return null;
    return { bytes: [...new Uint8Array(await object.arrayBuffer())], etag: object.etag, version: object.version, uploaded: object.uploaded, size: object.size, checksums: object.checksums.toJSON(), httpMetadata: object.httpMetadata, customMetadata: object.customMetadata };
  }
  async function recordStoredImage(key: string) {
    const input = await request();
    await f.binding.prepare("INSERT INTO game_images(id,game_id,type,source_url,source_provider,storage_key,storage_url,content_hash,mime_type,file_size,width,height) VALUES(1,9,'cover',?,'steam',?,?,?,'image/jpeg',?,48,32)").bind(source, key, `${publicUrl}/${key}`, input.hash, jpeg.length).run();
  }
  async function scheduledIngest() {
    const authority = await acquire();
    vi.stubGlobal("fetch", async () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }));
    const response = await imageWorker.fetch(new Request(`https://worker.test${SCHEDULED_IMAGE_PATH}`, { method: "POST", headers: { authorization: "Bearer scheduled", "content-type": "application/json" }, body: JSON.stringify({ version: 1, mode: "scheduled", requestId: crypto.randomUUID(), gameId: 9, write: true, authority }) }), { DB: f.binding, IMAGES_BUCKET: bucket, IMAGE_PUBLIC_BASE_URL: publicUrl, IMAGE_INGEST_TOKEN: "legacy", IMAGE_INGEST_SCHEDULED_TOKEN: "scheduled" }, {} as ExecutionContext);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ result: { images: Array<{ outcome: string }> } }>;
  }

  it.each(["covers/current.jpg", "images/sha256/aa/aa/" + "a".repeat(64) + ".jpg"])("does not restore a recorded noncanonical key %s through the actual scheduled route", async key => {
    await recordStoredImage(key);
    const result = await scheduledIngest();
    expect(result.result.images.map(image => image.outcome)).toEqual(["storage_conflict"]);
    expect(events).toEqual([]);
    expect(await bucket.head(key)).toBeNull();
  });

  it("restores a missing canonical key only with the exact recorded content and repeats concretely", async () => {
    const input = await request();
    await recordStoredImage(input.key);
    const first = await scheduledIngest();
    expect(first.result.images.map(image => image.outcome)).toEqual(["restored"]);
    expect((await objectSnapshot(input.key))?.bytes).toEqual([...jpeg]);
    const before = await objectSnapshot(input.key);
    const repeated = await store().ensureObject(input);
    expect(repeated.outcome).toBe("deduplicated");
    expect(await objectSnapshot(input.key)).toEqual(before);
    expect(events).toEqual(["r2.put.dispatched", "r2.put.completed"]);
  });

  it("rejects a bad supplied checksum without leaving an artifact", async () => {
    const input = await request();
    const result = await store().ensureObject({ ...input, bytes: newerJpeg });
    expect(result.outcome).toBe("storage_failed");
    expect(await bucket.head(input.key)).toBeNull();
    expect(events).toEqual(["r2.put.dispatched"]);
  });

  it.each(["identical", "hash", "mime", "size", "metadata", "cache"])("preserves the actual conditional race winner with %s content/metadata", async variant => {
    const input = await request();
    const winnerBytes = variant === "hash" ? new Uint8Array([...jpeg.slice(0, -1), 218]) : variant === "size" ? newerJpeg : jpeg;
    const winnerHash = await sha256Hex(winnerBytes);
    let before: Awaited<ReturnType<typeof objectSnapshot>>;
    let firstHead = true;
    const racingBucket = new Proxy(bucket, { get(target, key) {
      if (key === "head") return async (key: string) => {
        const result = await target.head(key);
        if (firstHead) {
          firstHead = false;
          expect(result).toBeNull();
          await target.put(key, winnerBytes, { onlyIf: { etagDoesNotMatch: "*" }, sha256: winnerHash, httpMetadata: { contentType: variant === "mime" ? "image/png" : "image/jpeg", cacheControl: variant === "cache" ? "no-cache" : cacheControl }, customMetadata: { sha256: variant === "metadata" ? "wrong" : winnerHash, size: String(winnerBytes.length) } });
          before = await objectSnapshot(key);
        }
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    expect((await store(racingBucket).ensureObject(input)).outcome).toBe(variant === "identical" ? "concurrent_dedup" : "storage_conflict");
    expect(await objectSnapshot(input.key)).toEqual(before!);
    expect((await store().ensureObject(input)).outcome).toBe(variant === "identical" ? "deduplicated" : "storage_conflict");
    expect(await objectSnapshot(input.key)).toEqual(before!);
    expect(events).toEqual(["r2.put.dispatched", "r2.put.completed", "r2.put.dispatched", "r2.put.completed"]);
  });

  it.each(["bind", "create"])("rejects A's late %s after R2 completion and B's newer publication", async operation => {
    if (operation === "bind") await f.binding.prepare("INSERT INTO game_images(id,game_id,type,source_url,source_provider) VALUES(1,9,'cover',?,'steam')").bind(source).run();
    const authorityA = await acquire();
    const reached = deferred();
    const resume = deferred();
    const signalsA = createCronSignals();
    const ordered: string[] = [];
    const heldBucket = new Proxy(bucket, { get(target, key) {
      if (key === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
        const pending = target.put(...args);
        ordered.push("r2.put.dispatched");
        reached.resolve();
        await resume.promise;
        const result = await pending;
        ordered.push("r2.put.completed");
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const observedD1 = new Proxy(f.binding, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => {
        ordered.push(`d1.${operation}.attempted`);
        return target.batch(statements);
      };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const serviceA = createImageIngestService({ repository: createScheduledImageRepository({ binding: observedD1, db: f.db, authority: authorityA, signals: signalsA }), r2: store(heldBucket), fetchImpl: async () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }) });
    const pendingA = serviceA.ingest(9, { write: true });
    await reached.promise;
    try {
      expect(ordered).toEqual(["r2.put.dispatched"]);
      await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
      const authorityB = await acquire();
      expect(authorityB.fenceEpoch).toBe(authorityA.fenceEpoch + 1);
      const serviceB = createImageIngestService({ repository: createScheduledImageRepository({ binding: f.binding, db: f.db, authority: authorityB, signals: createCronSignals() }), r2: store(), fetchImpl: async () => new Response(newerJpeg, { headers: { "content-type": "image/jpeg" } }) });
      expect((await serviceB.ingest(9, { write: true })).images.map(image => image.outcome)).toEqual(["ingested"]);
      const current = await request(newerJpeg);
      const currentBefore = await objectSnapshot(current.key);
      const dbBefore = await f.dump();
      expect((await f.binding.prepare("SELECT storage_key FROM game_images").all()).results).toEqual([{ storage_key: current.key }]);
      resume.resolve();
      expect((await pendingA).images.map(image => image.outcome)).toEqual(["d1_write_failed"]);
      expect(ordered).toEqual(["r2.put.dispatched", "r2.put.completed", `d1.${operation}.attempted`]);
      expect(signalsA.readAuthorityLoss()).toBe("fence_lost");
      expect(await f.dump()).toEqual(dbBefore);
      expect(await objectSnapshot(current.key)).toEqual(currentBefore);
      expect((await objectSnapshot((await request()).key))?.bytes).toEqual([...jpeg]);
      expect((await serviceB.ingest(9, { write: true })).images.map(image => image.outcome)).toEqual(["already_ingested"]);
      expect(await f.dump()).toEqual(dbBefore);
      expect(await objectSnapshot(current.key)).toEqual(currentBefore);
    } finally { resume.resolve(); await pendingA; }
  });
});
