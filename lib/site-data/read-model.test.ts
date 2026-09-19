import type { AnyD1Database } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD1TestBinding } from "../../test/d1-test-env";
import { createDatabase, type GameHubDatabase } from "../db/client";
import {
  companies,
  gameCompanies,
  gameCronSyncState,
  gameExternalIds,
  gameGenres,
  gameImages,
  gameOfficialLinks,
  gamePlatforms,
  gameVideos,
  games,
  genres,
  platforms,
} from "../db/schema";
import { readSiteSnapshot } from "./read-model";

function readOnlyBinding(binding: AnyD1Database, queries: string[]) {
  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => {
          queries.push(query);
          if (/^\s*(insert|update|delete|replace|upsert|alter|drop|create|pragma)\b/i.test(query)) {
            throw new Error(`read model attempted mutation: ${query}`);
          }
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("deterministic site data read model", () => {
  let binding: AnyD1Database;
  let db: GameHubDatabase;
  let dispose: (() => Promise<void>) | undefined;
  let queries: string[];

  beforeEach(async () => {
    const testEnv = await createD1TestBinding();
    binding = testEnv.binding;
    dispose = testEnv.dispose;
    queries = [];
    const setupDb = createDatabase(binding);

    await setupDb.insert(games).values([
      { id: 2, slug: "zeta", title: "Zeta", status: "released", releaseDate: "2026-01-01", description: "Z", coverUrl: "https://cdn.akamai.steamstatic.com/z", heroUrl: "https://images.igdb.com/z" },
      { id: 1, slug: "alpha", title: "Alpha", status: "released", releaseDate: "2026-01-01", description: "A", coverUrl: "https://cdn.akamai.steamstatic.com/a", heroUrl: "https://images.igdb.com/a" },
    ]);
    const [genreZ, genreA] = await setupDb.insert(genres).values([
      { id: 2, slug: "z", name: "Z Genre" },
      { id: 1, slug: "a", name: "A Genre" },
    ]).returning();
    const [platformZ, platformA] = await setupDb.insert(platforms).values([
      { id: 2, slug: "z", name: "Z Platform" },
      { id: 1, slug: "a", name: "A Platform" },
    ]).returning();
    const [companyZ, companyA] = await setupDb.insert(companies).values([
      { id: 2, slug: "z", name: "Z Studio" },
      { id: 1, slug: "a", name: "A Studio" },
    ]).returning();

    await setupDb.insert(gameExternalIds).values([
      { gameId: 1, provider: "gog", externalId: "g1" },
      { gameId: 1, provider: "steam", externalId: "10", externalUrl: "https://store.steampowered.com/app/10/" },
    ]);
    await setupDb.insert(gameGenres).values([{ gameId: 1, genreId: genreZ!.id }, { gameId: 1, genreId: genreA!.id }]);
    await setupDb.insert(gamePlatforms).values([{ gameId: 1, platformId: platformZ!.id }, { gameId: 1, platformId: platformA!.id }]);
    await setupDb.insert(gameCompanies).values([
      { gameId: 1, companyId: companyZ!.id, role: "publisher" },
      { gameId: 1, companyId: companyA!.id, role: "developer" },
    ]);
    await setupDb.insert(gameOfficialLinks).values([
      { id: 2, gameId: 1, provider: "z", linkType: "store", url: "https://z.example/", isOfficial: true, verificationStatus: "verified", verificationMethod: "http" },
      { id: 1, gameId: 1, provider: "a", linkType: "official_website", url: "https://a.example/", isOfficial: true, verificationStatus: "verified", verificationMethod: "manual" },
    ]);
    await setupDb.insert(gameImages).values([
      { id: 4, gameId: 1, type: "screenshot", sourceUrl: "https://images.igdb.com/shot", sourceProvider: "igdb", storageUrl: "https://r2.example/shot", storageKey: "private/shot", contentHash: "a".repeat(64), mimeType: "image/jpeg", fileSize: 1, sortOrder: 0 },
      { id: 3, gameId: 1, type: "cover", sourceUrl: "https://cdn.akamai.steamstatic.com/cover", sourceProvider: "steam", sortOrder: 0 },
      { id: 2, gameId: 1, type: "hero", sourceUrl: "https://images.igdb.com/hero", sourceProvider: "igdb", sortOrder: 0 },
    ]);
    await setupDb.insert(gameVideos).values([
      { id: 2, gameId: 1, provider: "youtube", externalId: "bbbbbbbbbbb", title: "B", sortOrder: 1, thumbnailUrl: "https://private/thumb" },
      { id: 1, gameId: 1, provider: "youtube", externalId: "aaaaaaaaaaa", title: "A", sortOrder: 0 },
    ]);
    await setupDb.insert(gameCronSyncState).values({ gameId: 1, lastAttemptAt: 1, lastStatus: "succeeded" });
    db = createDatabase(readOnlyBinding(binding, queries));
  });

  afterEach(async () => dispose?.());

  it("loads public canonical data in stable order without operational or R2 fields", async () => {
    const snapshot = await readSiteSnapshot(db);
    expect(snapshot.games.map((game) => game.game.slug)).toEqual(["alpha", "zeta"]);
    const game = snapshot.games[0]!;
    expect(game.externalIds.map((row) => row.provider)).toEqual(["gog", "steam"]);
    expect(game.genres.map((row) => row.name)).toEqual(["A Genre", "Z Genre"]);
    expect(game.platforms.map((row) => row.name)).toEqual(["A Platform", "Z Platform"]);
    expect(game.companies.map((row) => `${row.role}:${row.name}`)).toEqual(["developer:A Studio", "publisher:Z Studio"]);
    expect(game.officialLinks.map((row) => row.id)).toEqual([1, 2]);
    expect(game.images.map((row) => `${row.type}:${row.id}`)).toEqual(["cover:3", "hero:2", "screenshot:4"]);
    expect(game.videos.map((row) => row.externalId)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(game.images[2]).not.toHaveProperty("storageKey");
    expect(game.images[2]).not.toHaveProperty("storageUrl");
    expect(game.videos[0]).not.toHaveProperty("thumbnailUrl");
  });

  it("uses only SELECT queries and never queries scheduler tables", async () => {
    await readSiteSnapshot(db);
    expect(queries.every((query) => /^\s*select\b/i.test(query))).toBe(true);
    expect(queries.join("\n")).not.toMatch(/game_cron_sync_state|cron_sync_lease|fence_epoch|provider_payload/i);
  });

  it("executes the export read set through one D1 batch snapshot", async () => {
    const batches: unknown[][] = [];
    const batchBinding = new Proxy(binding, {
      get(target, property, receiver) {
        if (property === "batch") return async (statements: unknown[]) => { batches.push(statements); return target.batch(statements as never); };
        return Reflect.get(target, property, receiver);
      },
    });
    await readSiteSnapshot(createDatabase(batchBinding));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(8);
  });
});
