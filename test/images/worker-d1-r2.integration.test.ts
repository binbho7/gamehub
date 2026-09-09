import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/images/hash";
import { buildImageStorageKey } from "../../lib/images/storage-key";
import {
  startLocalImageWorker,
  type LocalImageWorker,
} from "../helpers/local-image-worker";

const IMAGE_BYTES = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);

const LOCAL_WORKER_TEST_TIMEOUT_MS = 30_000;

describe("local image Worker D1/R2 integration", () => {
  let worker: LocalImageWorker | undefined;
  let fixtureServer: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => fixtureServer?.close(() => resolve()) ?? resolve());
    fixtureServer = undefined;
    await worker?.stop();
    worker = undefined;
  });

  it("applies local migrations and keeps foreign keys valid", async () => {
    worker = await startLocalImageWorker();
    const tables = await worker.read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_images'",
    );
    expect(tables).toEqual([{ name: "game_images" }]);
    const columns = await worker.read<{ name: string }>("PRAGMA table_info('game_images')");
    expect(columns).toHaveLength(15);
    expect(await worker.read("PRAGMA foreign_key_check")).toEqual([]);
  }, LOCAL_WORKER_TEST_TIMEOUT_MS);

  it("runs an eligible source GET through validation and hashing, with dry-run HEAD-only and write PUT-before-D1", async () => {
    fixtureServer = createServer((_request, response) => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "image/jpeg");
      response.end(Buffer.from(IMAGE_BYTES));
    });
    await new Promise<void>((resolve, reject) => { fixtureServer!.once("error", reject); fixtureServer!.listen(0, "127.0.0.1", () => resolve()); });
    const address = fixtureServer.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not start");
    const fixtureUrl = `http://127.0.0.1:${address.port}/fixture.jpg`;
    const sourceUrl = "https://cdn.akamai.steamstatic.com/steam/apps/703/header.jpg";
    const fetchCalls: string[] = [];
    const sourceFetch: typeof fetch = async (_url, init) => {
      fetchCalls.push(String(_url));
      return fetch(fixtureUrl, init);
    };
    const counts = { r2Head: 0, r2Put: 0, rowsAtPut: -1 };

    worker = await startLocalImageWorker();
    await worker.seed(async ({ db }) => {
      await db.prepare("DELETE FROM game_images WHERE game_id = ?").bind(703).run();
      await db.prepare("DELETE FROM games WHERE id = ?").bind(703).run();
      await db.prepare("INSERT INTO games (id, slug, title, cover_url) VALUES (?, ?, ?, ?)")
        .bind(703, "eligible-source-game", "Eligible Source Game", sourceUrl).run();
    });

    const beforeDryRun = await worker.read("SELECT * FROM game_images WHERE game_id = 703");
    const dryRun = await worker.requestWithSource(703, false, sourceFetch, counts);
    expect(dryRun.status).toBe(200);
    await expect(dryRun.json()).resolves.toMatchObject({
      gameId: 703,
      status: "completed",
      preflightError: null,
      images: [{ imageId: null, outcome: "ingested" }],
    });
    expect(fetchCalls).toEqual([sourceUrl]);
    expect(counts.r2Head).toBe(1);
    expect(counts.r2Put).toBe(0);
    expect(await worker.read("SELECT * FROM game_images WHERE game_id = 703")).toEqual(beforeDryRun);

    const write = await worker.requestWithSource(703, true, sourceFetch, counts);
    expect(write.status).toBe(200);
    await expect(write.json()).resolves.toMatchObject({
      gameId: 703,
      status: "completed",
      preflightError: null,
      images: [{ imageId: expect.any(Number), outcome: "ingested" }],
    });
    expect(fetchCalls).toEqual([sourceUrl, sourceUrl]);
    expect(counts.r2Put).toBe(1);
    expect(counts.rowsAtPut).toBe(0);
    const rows = await worker.read<{ storage_url: string | null; storage_key: string | null; content_hash: string | null; mime_type: string | null; file_size: number | null; width: number | null; height: number | null }>(
      "SELECT storage_url, storage_key, content_hash, mime_type, file_size, width, height FROM game_images WHERE game_id = 703",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mime_type: "image/jpeg", file_size: IMAGE_BYTES.byteLength, width: 48, height: 32 });
    expect(rows[0]?.storage_url).toEqual(expect.any(String));
    expect(rows[0]?.storage_key).toEqual(expect.stringContaining("images/sha256/"));
    expect(rows[0]?.content_hash).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
  }, LOCAL_WORKER_TEST_TIMEOUT_MS);

  it("executes an eligible GET, R2 PUT and D1 binding inside workerd over localhost", async () => {
    let getCount = 0;
    fixtureServer = createServer((request, response) => {
      expect(request.method).toBe("GET");
      getCount += 1;
      response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(IMAGE_BYTES.length) });
      response.end(Buffer.from(IMAGE_BYTES));
    });
    await new Promise<void>((resolve, reject) => { fixtureServer!.once("error", reject); fixtureServer!.listen(0, "127.0.0.1", () => resolve()); });
    const address = fixtureServer.address();
    if (!address || typeof address === "string") throw new Error("fixture startup failed");
    worker = await startLocalImageWorker({ fixtureOrigin: `http://127.0.0.1:${address.port}` });
    await worker.seed(async ({ db }) => {
      await db.prepare("INSERT INTO games (id, slug, title, cover_url) VALUES (?, ?, ?, ?)")
        .bind(704, "workerd-image", "Workerd Image", "https://cdn.akamai.steamstatic.com/704.jpg?token=fixture-source-secret").run();
    });
    const dryRun = await worker.request(704, false);
    expect(dryRun.status).toBe(200);
    expect(getCount).toBe(1);
    expect(dryRun.headers.get("x-test-runtime")).toBe("workerd");
    expect(dryRun.headers.get("x-test-r2-head")).toBe("1");
    expect(dryRun.headers.get("x-test-r2-put")).toBe("0");
    expect(await worker.read("SELECT * FROM game_images WHERE game_id = 704")).toEqual([]);
    const dryText = await dryRun.text();
    expect(dryText).not.toContain("fixture-source-secret");
    expect(JSON.parse(dryText)).toMatchObject({ images: [{ outcome: "ingested", dimensions: { width: 48, height: 32 }, attempts: [{ status: 200 }] }] });
    const write = await worker.request(704, true);
    expect(write.status).toBe(200);
    expect(write.headers.get("x-test-r2-put")).toBe("1");
    expect(write.headers.get("x-test-rows-before-put")).toBe("0");
    expect(await write.json()).toMatchObject({ images: [{ outcome: "ingested", imageId: expect.any(Number) }] });
    expect(await worker.read("SELECT mime_type, file_size, width, height FROM game_images WHERE game_id = 704"))
      .toEqual([{ mime_type: "image/jpeg", file_size: IMAGE_BYTES.length, width: 48, height: 32 }]);
    expect(getCount).toBe(2);
  }, LOCAL_WORKER_TEST_TIMEOUT_MS);

  it("runs a real localhost dry-run and performs no D1/R2 mutation", async () => {
    worker = await startLocalImageWorker();
    const hash = await sha256Hex(IMAGE_BYTES);
    const key = buildImageStorageKey(hash, "image/jpeg");
    const storageUrl = `http://localhost:8787/images/${key}`;
    const now = Date.now();
    await worker.seed(async ({ db, bucket }) => {
      await db.prepare("DELETE FROM game_images WHERE game_id = ?").bind(701).run();
      await db.prepare("DELETE FROM games WHERE id = ?").bind(701).run();
      await db.prepare("INSERT INTO games (id, slug, title, cover_url, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(701, "local-image-game", "Local Image Game", "https://cdn.akamai.steamstatic.com/steam/apps/701/header.jpg", now)
        .run();
      await db.prepare(`
        INSERT INTO game_images (
          id, game_id, type, source_url, source_provider, storage_url, storage_key,
          content_hash, mime_type, file_size, width, height, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        801, 701, "cover", "https://cdn.akamai.steamstatic.com/steam/apps/701/header.jpg", "steam",
        storageUrl, key, hash, "image/jpeg", IMAGE_BYTES.byteLength, 1, 1, 0, now, now,
      ).run();
      await bucket.put(key, IMAGE_BYTES, {
        sha256: hash,
        httpMetadata: { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { sha256: hash, size: String(IMAGE_BYTES.byteLength) },
      });
    });
    const beforeRows = await worker.read("SELECT * FROM game_images WHERE game_id = 701");
    const beforeObjects = await worker.head(key);

    const response = await worker.request(701, false);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      gameId: 701,
      status: "completed",
      preflightError: null,
      images: [{ imageId: 801, outcome: "already_ingested" }],
    });

    const writeResponse = await worker.request(701, true);
    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toMatchObject({
      gameId: 701,
      status: "completed",
      images: [{ imageId: 801, outcome: "already_ingested" }],
    });

    expect(await worker.read("SELECT * FROM game_images WHERE game_id = 701")).toEqual(beforeRows);
    expect(await worker.head(key)).toEqual(beforeObjects);
  }, LOCAL_WORKER_TEST_TIMEOUT_MS);

  it("enforces R2 metadata checks and cascades image rows on game deletion", async () => {
    worker = await startLocalImageWorker();
    await worker.seed(async ({ db }) => {
      await db.prepare("DELETE FROM game_images WHERE game_id = ?").bind(702).run();
      await db.prepare("DELETE FROM games WHERE id = ?").bind(702).run();
      await db.prepare("INSERT INTO games (id, slug, title) VALUES (?, ?, ?)")
        .bind(702, "local-check-game", "Local Check Game").run();
      await db.prepare("INSERT INTO game_images (id, game_id, type, source_url) VALUES (?, ?, ?, ?)")
        .bind(802, 702, "cover", "https://cdn.akamai.steamstatic.com/steam/apps/702/header.jpg").run();

      await expect(db.prepare(`
        INSERT INTO game_images (id, game_id, type, source_url, storage_url)
        VALUES (?, ?, ?, ?, ?)
      `).bind(803, 702, "hero", "https://cdn.akamai.steamstatic.com/steam/apps/702/hero.jpg", "partial").run())
        .rejects.toThrow();
      await expect(db.prepare(`
        UPDATE game_images SET file_size = 0 WHERE id = ?
      `).bind(802).run()).rejects.toThrow();
      await expect(db.prepare(`
        UPDATE game_images SET source_provider = 'unknown' WHERE id = ?
      `).bind(802).run()).rejects.toThrow();

      await db.prepare("DELETE FROM games WHERE id = ?").bind(702).run();
    });
    expect(await worker.read("SELECT id FROM game_images WHERE game_id = 702")).toEqual([]);
    expect(await worker.read("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("rejects unauthorized localhost requests before touching local bindings", async () => {
    worker = await startLocalImageWorker();
    const response = await fetch(`${worker.baseUrl}/internal/images/ingest`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: 701, write: false }),
    });
    expect(response.status).toBe(401);
  }, LOCAL_WORKER_TEST_TIMEOUT_MS);
});
