import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  runImageMigrationPreflight,
  runImageMigrationPreflightCli,
  type ImageMigrationPreflightPlatform,
} from "../../scripts/check-image-migration";

describe("image migration preflight", () => {
  const disposers: Array<() => Promise<void>> = [];

  async function createLocalBinding() {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    const wrap = (sql: string, bound: unknown[] = []) => {
      const statement = database.prepare(sql);
      return {
        bind(...params: unknown[]) { return wrap(sql, params); },
        async run(...params: unknown[]) {
          const values = params.length > 0 ? params : bound;
          return statement.run(...(values as never[]));
        },
        async all<T = Record<string, unknown>>(...params: unknown[]) {
          const values = params.length > 0 ? params : bound;
          return { results: statement.all(...(values as never[])) as T[] };
        },
        async get<T = Record<string, unknown>>(...params: unknown[]) {
          const values = params.length > 0 ? params : bound;
          return statement.get(...(values as never[])) as T | undefined;
        },
        async raw(...params: unknown[]) {
          const values = params.length > 0 ? params : bound;
          const rows = statement.all(...(values as never[])) as Record<string, unknown>[];
          const columns = statement.columns().map((column) => column.name);
          return rows.map((row) => columns.map((column) => row[column]));
        },
      };
    };
    const binding = { prepare: (sql: string) => wrap(sql) };
    const migrationDirectory = new URL("../../drizzle/", import.meta.url);
    for (const file of (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort()) {
      const migration = await readFile(new URL(file, migrationDirectory), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        const sql = statement.trim();
        if (sql) await binding.prepare(sql).run();
      }
    }
    return { binding, dispose: async () => database.close() };
  }

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it("reports legacy storage and duplicate identity counts without changing rows", async () => {
    const local = await createLocalBinding();
    disposers.push(local.dispose);
    const db = local.binding;
    await db.prepare("INSERT INTO games (id, slug, title) VALUES (501, 'preflight-game', 'Preflight Game')").run();
    await db.prepare(`
      INSERT INTO game_images (
        id, game_id, type, source_url, source_provider, storage_url, storage_key,
        content_hash, mime_type, file_size, width, height, sort_order
      ) VALUES (
        601, 501, 'cover', 'https://cdn.akamai.steamstatic.com/one.jpg', 'steam',
        'https://images.test/object', 'images/sha256/aa/bb/hash.jpg',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'image/jpeg', 4, 1, 1, 0
      )
    `).run();
    await db.prepare(`
      INSERT INTO game_images (id, game_id, type, source_url, storage_url, sort_order)
      VALUES (602, 501, 'hero', 'https://cdn.akamai.steamstatic.com/one.jpg', NULL, 1)
    `).run();

    const before = await db.prepare(`
      SELECT id, game_id, type, source_url, storage_url, sort_order
      FROM game_images WHERE game_id = 501 ORDER BY id
    `).all();
    const platform: ImageMigrationPreflightPlatform = {
      env: { DB: db as never },
      dispose: () => undefined,
    };

    await expect(runImageMigrationPreflight(async () => platform)).resolves.toEqual({
      legacyStorageUrlCount: 1,
      duplicateIdentityCount: 1,
    });
    await expect(db.prepare(`
      SELECT id, game_id, type, source_url, storage_url, sort_order
      FROM game_images WHERE game_id = 501 ORDER BY id
    `).all()).resolves.toEqual(before);

    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(runImageMigrationPreflightCli(async () => platform, {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    })).resolves.toBe(1);
    expect(stdout).toEqual([
      "legacyStorageUrlCount: 1",
      "duplicateIdentityCount: 1",
    ]);
    expect(stderr).toEqual(["Image migration preflight failed; stop before applying migration 4"]);
  });

  it("returns zero counts for a clean local database", async () => {
    const local = await createLocalBinding();
    disposers.push(local.dispose);
    const platform: ImageMigrationPreflightPlatform = {
      env: { DB: local.binding as never },
      dispose: () => undefined,
    };
    await expect(runImageMigrationPreflight(async () => platform)).resolves.toEqual({
      legacyStorageUrlCount: 0,
      duplicateIdentityCount: 0,
    });
    await expect(runImageMigrationPreflightCli(async () => platform, {
      stdout: () => undefined,
      stderr: () => undefined,
    })).resolves.toBe(0);
  });

});
