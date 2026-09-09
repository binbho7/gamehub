import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../lib/images/hash";
import { buildImageStorageKey } from "../../lib/images/storage-key";
import {
  startLocalImageWorker,
  type LocalImageWorker,
} from "../helpers/local-image-worker";

const IMAGE_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xd9,
]);

describe("local image Worker D1/R2 integration", () => {
  let worker: LocalImageWorker | undefined;

  afterEach(async () => {
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
  });

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
  });

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
  });
});
