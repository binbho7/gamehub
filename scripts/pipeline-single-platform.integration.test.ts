import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../lib/db/client";
import { createImageIngestRepository } from "../lib/db/repositories/image-ingest";
import { createImageIngestService } from "../lib/images/service";
import { createR2ImageStore } from "../lib/images/r2-store";

const IMAGE_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  0xff, 0xd9,
]);

type Bindings = {
  DB: AnyD1Database;
  IMAGES_BUCKET: R2Bucket;
  IMAGE_PUBLIC_BASE_URL: string;
};

async function applyMigrations(binding: AnyD1Database): Promise<void> {
  const directory = new URL("../drizzle/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    const migration = await readFile(new URL(file, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql) await binding.prepare(sql).run();
    }
  }
}

describe("V2.10 pipeline single local platform integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("shares one real local D1/R2 runtime across eight concurrent ledger and image writes", async () => {
    const persistRoot = await mkdtemp(join(tmpdir(), "gamehub-single-platform-"));
    cleanup.push(persistRoot);
    const { getPlatformProxy } = await import("wrangler");
    const platform = await getPlatformProxy<Bindings>({
      configPath: fileURLToPath(new URL("../workers/image-ingest/wrangler.jsonc", import.meta.url)),
      persist: { path: join(persistRoot, "v3") },
      remoteBindings: false,
      envFiles: [],
    });

    try {
      await applyMigrations(platform.env.DB);
      const runId = `pipeline-v2.10:${"a".repeat(64)}`;
      await platform.env.DB.prepare(`INSERT INTO pipeline_runs
        (run_id, manifest_hash, pipeline_version, policy_version, snapshot_date, status,
         run_stage_states_json, created_at, updated_at)
        VALUES (?, ?, '2.10', '1', '2026-09-19', 'running', '{}', 1, 1)`)
        .bind(runId, "a".repeat(64)).run();

      for (let index = 1; index <= 8; index += 1) {
        const sourceUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${index}/header.jpg`;
        await platform.env.DB.prepare("INSERT INTO games (id, slug, title, cover_url) VALUES (?, ?, ?, ?)")
          .bind(index, `game-${index}`, `Game ${index}`, sourceUrl).run();
        await platform.env.DB.prepare(`INSERT INTO pipeline_run_items
          (run_id, ordinal, steam_app_id, current_stage, current_state, stage_states_json, updated_at)
          VALUES (?, ?, ?, 'images', 'running', '{}', 1)`)
          .bind(runId, index, String(index)).run();
      }

      const service = createImageIngestService({
        repository: createImageIngestRepository(createDatabase(platform.env.DB)),
        r2: createR2ImageStore(platform.env.IMAGES_BUCKET, platform.env.IMAGE_PUBLIC_BASE_URL),
        fetchImpl: async () => new Response(IMAGE_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": String(IMAGE_BYTES.length) },
        }),
      });

      await Promise.all(Array.from({ length: 8 }, async (_, offset) => {
        const gameId = offset + 1;
        await Promise.all([
          service.ingest(gameId, { write: true }),
          platform.env.DB.prepare(`UPDATE pipeline_run_items
            SET current_state = 'succeeded', updated_at = 2
            WHERE run_id = ? AND ordinal = ?`).bind(runId, gameId).run(),
        ]);
      }));

      const images = await platform.env.DB.prepare(`SELECT game_id, storage_key, content_hash
        FROM game_images ORDER BY game_id`).all<{ game_id: number; storage_key: string; content_hash: string }>();
      expect(images.results).toHaveLength(8);
      expect(images.results.map(({ game_id }) => game_id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      for (const image of images.results) {
        expect(image.content_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(await platform.env.IMAGES_BUCKET.head(image.storage_key)).not.toBeNull();
      }
      const ledger = await platform.env.DB.prepare(`SELECT ordinal, current_state
        FROM pipeline_run_items WHERE run_id = ? ORDER BY ordinal`).bind(runId)
        .all<{ ordinal: number; current_state: string }>();
      expect(ledger.results).toEqual(Array.from({ length: 8 }, (_, index) => ({
        ordinal: index + 1,
        current_state: "succeeded",
      })));
    } finally {
      await platform.dispose();
    }
  }, 60_000);
});
