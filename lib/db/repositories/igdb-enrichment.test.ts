import { eq } from "drizzle-orm";
import type { AnyD1Database } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IgdbEnrichmentPlan, PlannedCreate } from "../../enrichers/igdb-candidate";
import { IgdbError } from "../../providers/igdb/errors";
import { createD1TestBinding } from "../../../test/d1-test-env";
import { createDatabase, type GameHubDatabase } from "../client";
import {
  companies,
  gameCompanies,
  gameExternalIds,
  gameGenres,
  gameImages,
  gameOfficialLinks,
  gamePlatforms,
  games,
  gameVideos,
  genres,
  platforms,
} from "../schema";
import {
  createIgdbEnrichmentStore,
  IGDB_MAX_BIND_PARAMS_PER_LOOKUP_QUERY,
  type IgdbEnrichmentStore,
} from "./igdb-enrichment";

type CapturedSelect = { sql: string; bindings: unknown[] };

type BatchCounter = { calls: number };

function countBatches(binding: AnyD1Database, counter: BatchCounter): AnyD1Database {
  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property === "batch") {
        return (...args: Parameters<AnyD1Database["batch"]>) => {
          counter.calls += 1;
          return target.batch(...args);
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function captureSelects(binding: AnyD1Database, captured: CapturedSelect[]): AnyD1Database {
  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty === "bind") {
                return (...values: unknown[]) => {
                  if (/^\s*select\b/i.test(query)) captured.push({ sql: query, bindings: values });
                  return statementTarget.bind(...values);
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementReceiver) as unknown;
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function boundedCandidates(total: number, first: string, second: string, prefix: string) {
  const filler = Array.from({ length: total - 2 }, (_, index) => `${prefix}-${index}`);
  const middle = Math.floor(filler.length / 2);
  return [second, ...filler.slice(0, middle), first, ...filler.slice(middle)];
}

function enrichmentPlan(
  action: IgdbEnrichmentPlan["action"],
  gameId: number,
  creates: PlannedCreate[] = [],
  updates: IgdbEnrichmentPlan["updates"] = [],
): IgdbEnrichmentPlan {
  return {
    action,
    gameId,
    slug: "atomic-enrichment",
    matchedIgdbGame: { id: "501", name: "Atomic Enrichment" },
    creates,
    updates,
    skips: [],
    warnings: [],
    conflicts: action === "blocked" ? [{
      code: "identity_conflict",
      field: "external_id.igdb",
      message: "A different IGDB identity is already canonical",
    }] : [],
  };
}

function approvedCreates(gameId: number): PlannedCreate[] {
  return [
    {
      entity: "external_id",
      key: "igdb:501",
      values: { gameId, provider: "igdb", externalId: "501", externalUrl: null },
    },
    {
      entity: "genre",
      key: "souls-like",
      values: { slug: "souls-like", name: "Souls-like" },
    },
    {
      entity: "game_genre",
      key: `${gameId}:role-playing`,
      values: { gameId, genreSlug: "role-playing" },
    },
    {
      entity: "game_genre",
      key: `${gameId}:souls-like`,
      values: { gameId, genreSlug: "souls-like" },
    },
    {
      entity: "platform",
      key: "playstation-5",
      values: { slug: "playstation-5", name: "PlayStation 5" },
    },
    {
      entity: "game_platform",
      key: `${gameId}:playstation-5`,
      values: { gameId, platformSlug: "playstation-5" },
    },
    {
      entity: "company",
      key: "atomic-studio",
      values: { slug: "atomic-studio", name: "Atomic Studio", websiteUrl: null },
    },
    {
      entity: "game_company",
      key: `${gameId}:atomic-studio:developer`,
      values: { gameId, companySlug: "atomic-studio", role: "developer" },
    },
    {
      entity: "official_link",
      key: "https://atomic.example.com/",
      values: {
        gameId,
        provider: "igdb",
        platform: null,
        linkType: "official_website",
        url: "https://atomic.example.com/",
        isOfficial: true,
        verificationStatus: "unverified",
        verificationMethod: null,
      },
    },
    {
      entity: "image",
      key: "https://images.example.com/atomic-cover.jpg",
      values: {
        gameId,
        type: "cover",
        sourceUrl: "https://images.example.com/atomic-cover.jpg",
        width: 600,
        height: 800,
        sortOrder: 0,
      },
    },
    {
      entity: "video",
      key: "igdb:atomic-trailer",
      values: {
        gameId,
        provider: "igdb",
        externalId: "atomic-trailer",
        title: "Atomic Trailer",
        thumbnailUrl: "https://images.example.com/atomic-trailer.jpg",
        sortOrder: 0,
      },
    },
  ];
}

async function writableRows(database: GameHubDatabase) {
  const [
    gameRows,
    externalIdRows,
    genreRows,
    gameGenreRows,
    platformRows,
    gamePlatformRows,
    companyRows,
    gameCompanyRows,
    linkRows,
    imageRows,
    videoRows,
  ] = await Promise.all([
    database.select().from(games),
    database.select().from(gameExternalIds),
    database.select().from(genres),
    database.select().from(gameGenres),
    database.select().from(platforms),
    database.select().from(gamePlatforms),
    database.select().from(companies),
    database.select().from(gameCompanies),
    database.select().from(gameOfficialLinks),
    database.select().from(gameImages),
    database.select().from(gameVideos),
  ]);
  return {
    gameRows,
    externalIdRows,
    genreRows,
    gameGenreRows,
    platformRows,
    gamePlatformRows,
    companyRows,
    gameCompanyRows,
    linkRows,
    imageRows,
    videoRows,
  };
}

describe("IGDB enrichment repository reads on local D1", () => {
  let capturedSelects: CapturedSelect[];
  let batchCounter: BatchCounter;
  let binding: AnyD1Database;
  let db: GameHubDatabase;
  let dispose: (() => Promise<void>) | undefined;
  let store: IgdbEnrichmentStore;

  beforeEach(async () => {
    const testEnv = await createD1TestBinding();
    dispose = testEnv.dispose;
    binding = testEnv.binding;
    capturedSelects = [];
    batchCounter = { calls: 0 };
    db = createDatabase(captureSelects(countBatches(binding, batchCounter), capturedSelects));
    store = createIgdbEnrichmentStore(db);
  });

  afterEach(async () => dispose?.());

  it("returns a complete canonical snapshot and exactly one usable Steam App ID without writing", async () => {
    const [game] = await db.insert(games).values({
      slug: "elden-ring",
      title: "ELDEN RING",
      summary: "Stored summary",
      description: "Stored description",
      status: "released",
      releaseDate: "2022-02-25",
      coverUrl: "https://cdn.example.com/cover.jpg",
      heroUrl: "https://cdn.example.com/hero.jpg",
    }).returning();
    const [genre] = await db.insert(genres).values({ slug: "rpg", name: "RPG" }).returning();
    const [platform] = await db.insert(platforms).values({ slug: "windows", name: "Windows" }).returning();
    const [company] = await db.insert(companies).values({
      slug: "fromsoftware",
      name: "FromSoftware",
      websiteUrl: "https://www.fromsoftware.jp/",
    }).returning();

    await db.insert(gameExternalIds).values([
      {
        gameId: game!.id,
        provider: "steam",
        externalId: "1245620",
        externalUrl: "https://store.steampowered.com/app/1245620/",
      },
      { gameId: game!.id, provider: "gog", externalId: "elden-ring" },
    ]);
    await db.insert(gameGenres).values({ gameId: game!.id, genreId: genre!.id });
    await db.insert(gamePlatforms).values({ gameId: game!.id, platformId: platform!.id });
    await db.insert(gameCompanies).values({ gameId: game!.id, companyId: company!.id, role: "developer" });
    await db.insert(gameImages).values({
      gameId: game!.id,
      type: "cover",
      sourceUrl: "https://cdn.example.com/image.jpg",
      width: 600,
      height: 800,
      sortOrder: 0,
    });
    await db.insert(gameVideos).values({
      gameId: game!.id,
      provider: "youtube",
      externalId: "trailer-1",
      title: "Launch Trailer",
      thumbnailUrl: "https://cdn.example.com/trailer.jpg",
      sortOrder: 0,
    });
    await db.insert(gameOfficialLinks).values({
      gameId: game!.id,
      provider: "steam",
      linkType: "store",
      url: "https://store.steampowered.com/app/1245620/",
      verificationStatus: "verified",
      verificationMethod: "provider_api",
    });

    capturedSelects.length = 0;
    const snapshot = await store.findSnapshotByGameId(game!.id);

    expect(snapshot).toMatchObject({
      steamAppId: "1245620",
      game: {
        id: game!.id,
        slug: "elden-ring",
        title: "ELDEN RING",
        summary: "Stored summary",
        description: "Stored description",
        status: "released",
        releaseDate: "2022-02-25",
        coverUrl: "https://cdn.example.com/cover.jpg",
        heroUrl: "https://cdn.example.com/hero.jpg",
      },
      externalIds: [
        expect.objectContaining({ provider: "steam", externalId: "1245620" }),
        expect.objectContaining({ provider: "gog", externalId: "elden-ring" }),
      ],
      genres: [expect.objectContaining({ id: genre!.id, slug: "rpg", name: "RPG" })],
      platforms: [expect.objectContaining({ id: platform!.id, slug: "windows", name: "Windows" })],
      companies: [expect.objectContaining({
        id: company!.id,
        slug: "fromsoftware",
        name: "FromSoftware",
        websiteUrl: "https://www.fromsoftware.jp/",
        role: "developer",
      })],
      images: [expect.objectContaining({ type: "cover", sourceUrl: "https://cdn.example.com/image.jpg" })],
      videos: [expect.objectContaining({ provider: "youtube", externalId: "trailer-1" })],
      officialLinks: [expect.objectContaining({
        provider: "steam",
        linkType: "store",
        url: "https://store.steampowered.com/app/1245620/",
      })],
    });
    expect(capturedSelects.length).toBeGreaterThan(0);
    expect(capturedSelects.every(({ bindings }) => (
      bindings.length <= IGDB_MAX_BIND_PARAMS_PER_LOOKUP_QUERY
    ))).toBe(true);
  });

  it("returns null for a missing game and does not repair zero or multiple usable Steam IDs", async () => {
    const inserted = await db.insert(games).values([
      { slug: "invalid-steam", title: "Invalid Steam" },
      { slug: "multiple-steam", title: "Multiple Steam" },
    ]).returning();
    await db.insert(gameExternalIds).values([
      { gameId: inserted[0]!.id, provider: "steam", externalId: "not-a-steam-id" },
      { gameId: inserted[0]!.id, provider: "gog", externalId: "valid-other-provider" },
      { gameId: inserted[1]!.id, provider: "steam", externalId: "100" },
      { gameId: inserted[1]!.id, provider: "steam", externalId: "101" },
    ]);
    const before = await db.select().from(gameExternalIds);

    expect(await store.findSnapshotByGameId(999_999)).toBeNull();
    expect((await store.findSnapshotByGameId(inserted[0]!.id))!.steamAppId).toBeNull();
    expect((await store.findSnapshotByGameId(inserted[1]!.id))!.steamAppId).toBeNull();
    expect(await db.select().from(gameExternalIds)).toEqual(before);
  });

  it("deduplicates, chunks, and restores first-input order for every candidate lookup family", async () => {
    const [game] = await db.insert(games).values({ slug: "lookup-game", title: "Lookup Game" }).returning();
    const [otherGame] = await db.insert(games).values({ slug: "lookup-other", title: "Lookup Other" }).returning();
    const externalRows = await db.insert(gameExternalIds).values([
      { gameId: game!.id, provider: "igdb", externalId: "external-first" },
      { gameId: game!.id, provider: "igdb", externalId: "external-second" },
    ]).returning();
    const genreRows = await db.insert(genres).values([
      { slug: "genre-first", name: "Genre First" },
      { slug: "genre-second", name: "Genre Second" },
    ]).returning();
    const platformRows = await db.insert(platforms).values([
      { slug: "platform-first", name: "Platform First" },
      { slug: "platform-second", name: "Platform Second" },
    ]).returning();
    const companyRows = await db.insert(companies).values([
      { slug: "company-first", name: "Company First" },
      { slug: "company-second", name: "Company Second" },
    ]).returning();
    const imageRows = await db.insert(gameImages).values([
      { gameId: game!.id, type: "artwork", sourceUrl: "https://images.example.com/first.jpg" },
      { gameId: game!.id, type: "artwork", sourceUrl: "https://images.example.com/second.jpg" },
    ]).returning();
    const videoRows = await db.insert(gameVideos).values([
      { gameId: game!.id, provider: "youtube", externalId: "video-first" },
      { gameId: game!.id, provider: "youtube", externalId: "video-second" },
    ]).returning();
    const linkRows = await db.insert(gameOfficialLinks).values([
      {
        gameId: game!.id,
        provider: "igdb",
        linkType: "official_website",
        url: "https://first.example.com/",
      },
      {
        gameId: game!.id,
        provider: "igdb",
        linkType: "official_website",
        url: "https://second.example.com/",
      },
    ]).returning();
    await db.insert(gameExternalIds).values({
      gameId: otherGame!.id,
      provider: "steam",
      externalId: "external-first",
    });
    await db.insert(gameImages).values({
      gameId: otherGame!.id,
      type: "artwork",
      sourceUrl: "https://images.example.com/first.jpg",
    });
    await db.insert(gameVideos).values([
      { gameId: otherGame!.id, provider: "youtube", externalId: "video-first" },
      { gameId: game!.id, provider: "vimeo", externalId: "video-second" },
    ]);
    await db.insert(gameOfficialLinks).values({
      gameId: otherGame!.id,
      provider: "igdb",
      linkType: "official_website",
      url: "https://first.example.com/",
    });

    type LookupRow = { id: number };
    type LookupCase = {
      name: string;
      first: string;
      second: string;
      fixedBindings: number;
      rowKeys: Map<number, string>;
      lookup(values: string[]): Promise<LookupRow[]>;
    };
    const rowKeys = (rows: LookupRow[], keys: string[]) => new Map(rows.map((row, index) => [row.id, keys[index]!]));
    const cases: LookupCase[] = [
      {
        name: "external identities",
        first: "external-first",
        second: "external-second",
        fixedBindings: 1,
        rowKeys: rowKeys(externalRows, ["external-first", "external-second"]),
        lookup: (values) => store.findExternalIdsByProvider("igdb", values),
      },
      {
        name: "genre slugs",
        first: "genre-first",
        second: "genre-second",
        fixedBindings: 0,
        rowKeys: rowKeys(genreRows, ["genre-first", "genre-second"]),
        lookup: (values) => store.findGenresBySlugs(values),
      },
      {
        name: "genre names",
        first: "Genre First",
        second: "Genre Second",
        fixedBindings: 0,
        rowKeys: rowKeys(genreRows, ["Genre First", "Genre Second"]),
        lookup: (values) => store.findGenresByNames(values),
      },
      {
        name: "platform slugs",
        first: "platform-first",
        second: "platform-second",
        fixedBindings: 0,
        rowKeys: rowKeys(platformRows, ["platform-first", "platform-second"]),
        lookup: (values) => store.findPlatformsBySlugs(values),
      },
      {
        name: "platform names",
        first: "Platform First",
        second: "Platform Second",
        fixedBindings: 0,
        rowKeys: rowKeys(platformRows, ["Platform First", "Platform Second"]),
        lookup: (values) => store.findPlatformsByNames(values),
      },
      {
        name: "company slugs",
        first: "company-first",
        second: "company-second",
        fixedBindings: 0,
        rowKeys: rowKeys(companyRows, ["company-first", "company-second"]),
        lookup: (values) => store.findCompaniesBySlugs(values),
      },
      {
        name: "image source URLs",
        first: "https://images.example.com/first.jpg",
        second: "https://images.example.com/second.jpg",
        fixedBindings: 1,
        rowKeys: rowKeys(imageRows, [
          "https://images.example.com/first.jpg",
          "https://images.example.com/second.jpg",
        ]),
        lookup: (values) => store.findImagesBySourceUrls(game!.id, values),
      },
      {
        name: "video provider identities",
        first: "video-first",
        second: "video-second",
        fixedBindings: 2,
        rowKeys: rowKeys(videoRows, ["video-first", "video-second"]),
        lookup: (values) => store.findVideosByProviderAndExternalIds(game!.id, "youtube", values),
      },
      {
        name: "official-link URLs",
        first: "https://first.example.com/",
        second: "https://second.example.com/",
        fixedBindings: 1,
        rowKeys: rowKeys(linkRows, ["https://first.example.com/", "https://second.example.com/"]),
        lookup: (values) => store.findOfficialLinksByUrls(game!.id, values),
      },
    ];

    for (const lookupCase of cases) {
      const resultKeys = (rows: LookupRow[]) => rows.map((row) => lookupCase.rowKeys.get(row.id));

      capturedSelects.length = 0;
      expect(await lookupCase.lookup([]), lookupCase.name).toEqual([]);
      expect(capturedSelects, `${lookupCase.name} empty lookup`).toEqual([]);

      capturedSelects.length = 0;
      expect(resultKeys(await lookupCase.lookup([lookupCase.first])), lookupCase.name)
        .toEqual([lookupCase.first]);
      expect(capturedSelects).toHaveLength(1);

      capturedSelects.length = 0;
      expect(resultKeys(await lookupCase.lookup([
        lookupCase.second,
        "missing-value",
        lookupCase.first,
        lookupCase.second,
        lookupCase.first,
      ])), lookupCase.name).toEqual([lookupCase.second, lookupCase.first]);
      expect(capturedSelects).toHaveLength(1);
      expect(capturedSelects[0]!.bindings).toHaveLength(lookupCase.fixedBindings + 3);

      for (const total of [81, 163]) {
        capturedSelects.length = 0;
        const candidates = boundedCandidates(
          total,
          lookupCase.first,
          lookupCase.second,
          `missing-${lookupCase.name.replaceAll(" ", "-")}-${total}`,
        );
        candidates.push(lookupCase.second, lookupCase.first);

        expect(resultKeys(await lookupCase.lookup(candidates)), `${lookupCase.name} with ${total} unique candidates`)
          .toEqual([lookupCase.second, lookupCase.first]);
        const candidateCapacity = IGDB_MAX_BIND_PARAMS_PER_LOOKUP_QUERY - lookupCase.fixedBindings;
        expect(capturedSelects).toHaveLength(Math.ceil(total / candidateCapacity));
        expect(capturedSelects.reduce((count, query) => (
          count + query.bindings.length - lookupCase.fixedBindings
        ), 0)).toBe(total);
        expect(capturedSelects.every(({ bindings }) => (
          bindings.length <= IGDB_MAX_BIND_PARAMS_PER_LOOKUP_QUERY
        ))).toBe(true);
      }
    }
  });

  it("writes every explicit enrichment operation in exactly one atomic batch", async () => {
    const [game] = await db.insert(games).values({
      slug: "atomic-enrichment",
      title: "Canonical Title",
      summary: "Concurrent canonical summary",
    }).returning();
    const [sharedGenre] = await db.insert(genres).values({
      slug: "role-playing",
      name: "Role-playing (RPG)",
    }).returning();
    const plan = enrichmentPlan("enrich", game!.id, approvedCreates(game!.id), [{
      entity: "game",
      key: String(game!.id),
      changes: {
        summary: "IGDB summary",
        description: "IGDB description",
        releaseDate: "2026-09-03",
        coverUrl: "https://images.example.com/canonical-cover.jpg",
        heroUrl: "https://images.example.com/canonical-hero.jpg",
      },
    }]);

    batchCounter.calls = 0;
    const result = await store.applyPlan(plan);

    expect(result).toEqual({ affectedRows: 12 });
    expect(batchCounter.calls).toBe(1);
    expect((await db.select().from(games).where(eq(games.id, game!.id)))[0]).toMatchObject({
      title: "Canonical Title",
      summary: "Concurrent canonical summary",
      description: "IGDB description",
      releaseDate: "2026-09-03",
      coverUrl: "https://images.example.com/canonical-cover.jpg",
      heroUrl: "https://images.example.com/canonical-hero.jpg",
    });
    expect(await db.select().from(gameExternalIds)).toEqual([
      expect.objectContaining({
        gameId: game!.id,
        provider: "igdb",
        externalId: "501",
        externalUrl: null,
      }),
    ]);
    expect(await db.select().from(genres)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sharedGenre!.id, slug: "role-playing" }),
      expect.objectContaining({ slug: "souls-like", name: "Souls-like" }),
    ]));
    expect(await db.select().from(gameGenres)).toHaveLength(2);
    expect(await db.select().from(platforms)).toEqual([
      expect.objectContaining({ slug: "playstation-5", name: "PlayStation 5" }),
    ]);
    expect(await db.select().from(gamePlatforms)).toHaveLength(1);
    expect(await db.select().from(companies)).toEqual([
      expect.objectContaining({
        slug: "atomic-studio",
        name: "Atomic Studio",
        websiteUrl: null,
      }),
    ]);
    expect(await db.select().from(gameCompanies)).toEqual([
      { gameId: game!.id, companyId: expect.any(Number), role: "developer" },
    ]);
    expect(await db.select().from(gameOfficialLinks)).toEqual([
      expect.objectContaining({
        gameId: game!.id,
        provider: "igdb",
        platform: null,
        linkType: "official_website",
        url: "https://atomic.example.com/",
        isOfficial: true,
        verificationStatus: "unverified",
        verificationMethod: null,
      }),
    ]);
    expect(await db.select().from(gameImages)).toEqual([
      expect.objectContaining({
        gameId: game!.id,
        type: "cover",
        sourceUrl: "https://images.example.com/atomic-cover.jpg",
        width: 600,
        height: 800,
        sortOrder: 0,
      }),
    ]);
    expect(await db.select().from(gameVideos)).toEqual([
      expect.objectContaining({
        gameId: game!.id,
        provider: "igdb",
        externalId: "atomic-trailer",
        title: "Atomic Trailer",
        thumbnailUrl: "https://images.example.com/atomic-trailer.jpg",
        sortOrder: 0,
      }),
    ]);
  });

  it("rolls back every candidate delta on a late batch failure and sanitizes the write error", async () => {
    const [game] = await db.insert(games).values({
      slug: "atomic-enrichment",
      title: "Canonical Title",
    }).returning();
    const [sharedGenre] = await db.insert(genres).values({
      slug: "role-playing",
      name: "Role-playing (RPG)",
    }).returning();
    const before = await writableRows(db);
    await binding.prepare(`
      CREATE TRIGGER fail_igdb_video_insert
      BEFORE INSERT ON game_videos
      BEGIN
        SELECT RAISE(ABORT, 'injected private write detail');
      END
    `).run();
    const plan = enrichmentPlan("enrich", game!.id, approvedCreates(game!.id), [{
      entity: "game",
      key: String(game!.id),
      changes: { description: "IGDB description" },
    }]);

    batchCounter.calls = 0;
    let error: unknown;
    try {
      await store.applyPlan(plan);
    } catch (cause) {
      error = cause;
    } finally {
      await binding.prepare("DROP TRIGGER fail_igdb_video_insert").run();
    }

    expect(error).toBeInstanceOf(IgdbError);
    expect(error).toMatchObject({
      code: "write_conflict",
      message: "IGDB enrichment write conflict",
      retryable: false,
      cause: undefined,
      constraint: undefined,
    });
    expect(JSON.stringify(error)).not.toContain("injected private write detail");
    expect(batchCounter.calls).toBe(1);
    expect(await writableRows(db)).toEqual(before);
    expect((await db.select().from(genres).where(eq(genres.id, sharedGenre!.id)))[0])
      .toMatchObject({ slug: "role-playing", name: "Role-playing (RPG)" });
  });

  it("classifies only the IGDB external-identity unique constraint without exposing database detail", async () => {
    const [game] = await db.insert(games).values({
      slug: "identity-conflict",
      title: "Identity Conflict",
    }).returning();
    await db.insert(gameExternalIds).values({
      gameId: game!.id,
      provider: "igdb",
      externalId: "501",
    });
    const plan = enrichmentPlan("enrich", game!.id, approvedCreates(game!.id));

    let error: unknown;
    try {
      await store.applyPlan(plan);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(IgdbError);
    expect(error).toMatchObject({
      code: "write_conflict",
      message: "IGDB enrichment write conflict",
      retryable: false,
      cause: undefined,
      constraint: "igdb_external_identity_unique",
    });
    expect(JSON.stringify(error)).not.toContain("game_external_ids");
    expect(JSON.stringify(error)).not.toContain("UNIQUE constraint failed");
  });

  it("returns zero for an existing plan without constructing or executing a batch", async () => {
    const [game] = await db.insert(games).values({
      slug: "atomic-enrichment",
      title: "Canonical Title",
    }).returning();
    const plan = enrichmentPlan("existing", game!.id, approvedCreates(game!.id), [{
      entity: "game",
      key: String(game!.id),
      changes: { description: "must not be written" },
    }]);
    const before = await writableRows(db);

    batchCounter.calls = 0;
    expect(await store.applyPlan(plan)).toEqual({ affectedRows: 0 });
    expect(batchCounter.calls).toBe(0);
    expect(await writableRows(db)).toEqual(before);
  });

  it("rejects a blocked plan before constructing or executing a batch", async () => {
    const [game] = await db.insert(games).values({
      slug: "atomic-enrichment",
      title: "Canonical Title",
    }).returning();
    const plan = enrichmentPlan("blocked", game!.id, approvedCreates(game!.id), [{
      entity: "game",
      key: String(game!.id),
      changes: { description: "must not be written" },
    }]);
    const before = await writableRows(db);

    batchCounter.calls = 0;
    await expect(store.applyPlan(plan)).rejects.toMatchObject({
      code: "write_conflict",
      message: "Blocked IGDB enrichment plan cannot be written",
      retryable: false,
    });
    expect(batchCounter.calls).toBe(0);
    expect(await writableRows(db)).toEqual(before);
  });
});
