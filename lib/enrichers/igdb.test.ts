import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createD1TestBinding } from "../../test/d1-test-env";
import { createDatabase, type GameHubDatabase } from "../db/client";
import {
  createIgdbEnrichmentStore,
  type IgdbEnrichmentSnapshot,
  type IgdbEnrichmentStore,
} from "../db/repositories/igdb-enrichment";
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
} from "../db/schema";
import type { IgdbClient } from "../providers/igdb/client";
import { IgdbError } from "../providers/igdb/errors";
import { normalizeIgdbGame } from "../providers/igdb/normalize";
import { parseIgdbGame, parseIgdbSteamMapping } from "../providers/igdb/response";
import { createIgdbEnricher } from "./igdb";
import { planIgdbEnrichment } from "./igdb-plan";

const fetchedAt = new Date("2026-09-03T01:02:03.000Z");
const steamAppId = "1245620";
const igdbGameId = 119133;

const expectedMappingQuery = `fields id,game,uid,external_game_source;
where external_game_source = 1 & uid = "1245620";
limit 2;`;

const expectedGameQuery = `fields id,name,summary,storyline,first_release_date,genres.id,genres.name,genres.slug,platforms.id,platforms.name,platforms.slug,involved_companies.developer,involved_companies.publisher,involved_companies.company.id,involved_companies.company.name,involved_companies.company.slug,cover.image_id,cover.width,cover.height,artworks.image_id,artworks.width,artworks.height,screenshots.image_id,screenshots.width,screenshots.height,videos.video_id,videos.name,websites.type,websites.trusted,websites.url;
where id = 119133;
limit 1;`;

function mappingBody(game = igdbGameId) {
  return [{ id: 5036, game, uid: steamAppId, external_game_source: 1 }];
}

function minimalGameBody(overrides: Record<string, unknown> = {}) {
  return [{ id: igdbGameId, name: "Elden Ring", ...overrides }];
}

function externalIdRow(gameId: number, provider: string, externalId: string) {
  return {
    id: provider === "steam" ? gameId : gameId + 1_000,
    gameId,
    provider,
    externalId,
    externalUrl: null,
    createdAt: fetchedAt,
    updatedAt: fetchedAt,
  };
}

function snapshot(
  gameId = 42,
  igdbIds: string[] = [],
  overrides: Partial<IgdbEnrichmentSnapshot["game"]> = {},
): IgdbEnrichmentSnapshot {
  return {
    game: {
      id: gameId,
      slug: "elden-ring",
      title: "Elden Ring",
      summary: null,
      description: null,
      status: "released",
      releaseDate: null,
      coverUrl: null,
      heroUrl: null,
      createdAt: fetchedAt,
      updatedAt: fetchedAt,
      ...overrides,
    },
    steamAppId,
    externalIds: [
      externalIdRow(gameId, "steam", steamAppId),
      ...igdbIds.map((externalId) => externalIdRow(gameId, "igdb", externalId)),
    ],
    officialLinks: [],
    genres: [],
    platforms: [],
    companies: [],
    images: [],
    videos: [],
  };
}

type FakeStoreState = {
  snapshot: IgdbEnrichmentSnapshot | null;
  indexedExternalIds: Awaited<ReturnType<IgdbEnrichmentStore["findExternalIdsByProvider"]>>;
};

function fakeStore(
  state: FakeStoreState,
  events: string[] = [],
  applyPlan: IgdbEnrichmentStore["applyPlan"] = async () => ({ affectedRows: 1 }),
): IgdbEnrichmentStore {
  return {
    async findSnapshotByGameId() {
      events.push("snapshot");
      return state.snapshot;
    },
    async findExternalIdsByProvider(provider, externalIds) {
      events.push("plan:external-ids");
      return state.indexedExternalIds.filter((row) => (
        row.provider === provider && externalIds.includes(row.externalId)
      ));
    },
    async findGenresBySlugs() {
      events.push("plan:genre-slugs");
      return [];
    },
    async findGenresByNames() {
      events.push("plan:genre-names");
      return [];
    },
    async findPlatformsBySlugs() {
      events.push("plan:platform-slugs");
      return [];
    },
    async findPlatformsByNames() {
      events.push("plan:platform-names");
      return [];
    },
    async findCompaniesBySlugs() {
      events.push("plan:companies");
      return [];
    },
    async findImagesBySourceUrls() {
      events.push("plan:images");
      return [];
    },
    async findVideosByProviderAndExternalIds() {
      events.push("plan:videos");
      return [];
    },
    async findOfficialLinksByUrls() {
      events.push("plan:links");
      return [];
    },
    async applyPlan(plan) {
      events.push("apply");
      return applyPlan(plan);
    },
  };
}

function clientFor(
  events: string[] = [],
  mapping: unknown = mappingBody(),
  game: unknown = minimalGameBody(),
): IgdbClient {
  return {
    async request(endpoint, query) {
      events.push(`http:${endpoint}`);
      if (endpoint === "external_games") {
        expect(query).toBe(expectedMappingQuery);
        return { body: mapping, fetchedAt };
      }
      expect(query).toBe(expectedGameQuery);
      return { body: game, fetchedAt };
    },
  };
}

function identityWriteConflict() {
  return new IgdbError("write_conflict", "IGDB enrichment write conflict", {
    retryable: false,
    constraint: "igdb_external_identity_unique",
  });
}

function observableDependencies(
  store: IgdbEnrichmentStore,
  client: IgdbClient,
  events: string[],
) {
  return {
    store,
    client,
    parseSteamMapping(body: unknown, expectedSteamAppId: string) {
      events.push("adapt:mapping");
      return parseIgdbSteamMapping(body, expectedSteamAppId);
    },
    parseGame(body: unknown, expectedGameId: number) {
      events.push("adapt:game");
      return parseIgdbGame(body, expectedGameId);
    },
    normalizeGame: (...args: Parameters<typeof normalizeIgdbGame>) => {
      events.push("normalize");
      return normalizeIgdbGame(...args);
    },
    planEnrichment: (...args: Parameters<typeof planIgdbEnrichment>) => {
      events.push("plan");
      return planIgdbEnrichment(...args);
    },
  };
}

describe("createIgdbEnricher orchestration", () => {
  it("preserves snapshot, mapping, exact-game, normalization, planning, and write order with fixed queries", async () => {
    const events: string[] = [];
    const state = { snapshot: snapshot(), indexedExternalIds: [] };
    const store = fakeStore(state, events);
    const client = clientFor(events);

    const result = await createIgdbEnricher(observableDependencies(store, client, events))
      .enrichGame(42, { dryRun: false });

    expect(result).toMatchObject({
      status: "enrich",
      gameId: 42,
      dryRun: false,
      affectedRows: 1,
      plan: { action: "enrich", matchedIgdbGame: { id: "119133", name: "Elden Ring" } },
    });
    expect(events).toEqual([
      "snapshot",
      "http:external_games",
      "adapt:mapping",
      "http:games",
      "adapt:game",
      "normalize",
      "plan",
      "plan:external-ids",
      "plan:genre-slugs",
      "plan:genre-names",
      "plan:platform-slugs",
      "plan:platform-names",
      "plan:companies",
      "plan:images",
      "plan:videos",
      "plan:links",
      "apply",
    ]);
    expect(expectedGameQuery).not.toContain("company.url");
    expect(expectedGameQuery).not.toContain("fields *");
  });

  it("rejects an invalid canonical ID before reading the snapshot", async () => {
    const events: string[] = [];
    const store = fakeStore({ snapshot: snapshot(), indexedExternalIds: [] }, events);

    await expect(createIgdbEnricher({ client: clientFor(events), store })
      .enrichGame("42 OR 1=1" as unknown as number, { dryRun: true }))
      .rejects.toMatchObject({ code: "invalid_game_id", retryable: false });
    expect(events).toEqual([]);
  });

  it("stops before HTTP when the canonical game is missing", async () => {
    const events: string[] = [];
    const store = fakeStore({ snapshot: null, indexedExternalIds: [] }, events);

    await expect(createIgdbEnricher({ client: clientFor(events), store })
      .enrichGame(42, { dryRun: true }))
      .rejects.toMatchObject({ code: "canonical_game_not_found", retryable: false });
    expect(events).toEqual(["snapshot"]);
  });

  it.each([
    { name: "no usable Steam ID", steamIds: [] },
    { name: "an invalid supplied Steam ID", steamIds: ["001245620"] },
  ])("stops before HTTP with $name", async ({ steamIds }) => {
    const events: string[] = [];
    const local = snapshot();
    local.steamAppId = steamIds[0] ?? null;
    const store = fakeStore({ snapshot: local, indexedExternalIds: [] }, events);

    await expect(createIgdbEnricher({ client: clientFor(events), store })
      .enrichGame(42, { dryRun: true }))
      .rejects.toMatchObject({ code: "steam_external_id_missing", retryable: false });
    expect(events).toEqual(["snapshot"]);
  });

  it.each([
    { name: "missing", body: [], code: "mapping_not_found" },
    {
      name: "ambiguous",
      body: [...mappingBody(), ...mappingBody(119134).map((row) => ({ ...row, id: 5037 }))],
      code: "mapping_ambiguous",
    },
  ])("preserves a $name mapping error before the game request, normalizer, or planner", async ({ body, code }) => {
    const events: string[] = [];
    const store = fakeStore({ snapshot: snapshot(), indexedExternalIds: [] }, events);
    const dependencies = observableDependencies(store, clientFor(events, body), events);

    await expect(createIgdbEnricher(dependencies).enrichGame(42, { dryRun: true }))
      .rejects.toMatchObject({ code, retryable: false });
    expect(events).toEqual(["snapshot", "http:external_games", "adapt:mapping"]);
  });

  it("preserves an HTTP mapping error without invoking an adapter or planner", async () => {
    const events: string[] = [];
    const providerError = new IgdbError("rate_limited", "IGDB rate limited", {
      retryable: true,
      status: 429,
    });
    const store = fakeStore({ snapshot: snapshot(), indexedExternalIds: [] }, events);
    const client: IgdbClient = {
      async request() {
        events.push("http:external_games");
        throw providerError;
      },
    };

    await expect(createIgdbEnricher(observableDependencies(store, client, events))
      .enrichGame(42, { dryRun: true }))
      .rejects.toBe(providerError);
    expect(events).toEqual(["snapshot", "http:external_games"]);
  });

  it.each([
    { name: "existing", local: snapshot(42, [String(igdbGameId)]), expected: "existing" },
    { name: "blocked", local: snapshot(42, ["999999"]), expected: "blocked" },
  ])("never applies a $name plan", async ({ local, expected }) => {
    const events: string[] = [];
    const indexedExternalIds = local.externalIds.filter((row) => row.provider === "igdb");
    const store = fakeStore({ snapshot: local, indexedExternalIds }, events);

    const result = await createIgdbEnricher({ client: clientFor(events), store })
      .enrichGame(42, { dryRun: false });

    expect(result).toMatchObject({ status: expected, affectedRows: 0, dryRun: false });
    expect(events).not.toContain("apply");
  });
});

describe("createIgdbEnricher write-conflict recovery", () => {
  it("returns a fresh existing plan when a concurrent winner binds the same IGDB ID to the same game", async () => {
    const state: FakeStoreState = { snapshot: snapshot(), indexedExternalIds: [] };
    const conflict = identityWriteConflict();
    let applies = 0;
    const store = fakeStore(state, [], async () => {
      applies += 1;
      const winner = externalIdRow(42, "igdb", String(igdbGameId));
      state.snapshot = snapshot(42, [String(igdbGameId)]);
      state.indexedExternalIds = [winner];
      throw conflict;
    });

    const result = await createIgdbEnricher({ client: clientFor(), store })
      .enrichGame(42, { dryRun: false });

    expect(result).toMatchObject({
      status: "existing",
      gameId: 42,
      dryRun: false,
      affectedRows: 0,
      plan: { action: "existing" },
    });
    expect(applies).toBe(1);
  });

  it("returns blocked when a concurrent winner binds the IGDB ID to another game", async () => {
    const state: FakeStoreState = { snapshot: snapshot(), indexedExternalIds: [] };
    const store = fakeStore(state, [], async () => {
      state.indexedExternalIds = [externalIdRow(77, "igdb", String(igdbGameId))];
      throw identityWriteConflict();
    });

    const result = await createIgdbEnricher({ client: clientFor(), store })
      .enrichGame(42, { dryRun: false });

    expect(result).toMatchObject({
      status: "blocked",
      affectedRows: 0,
      plan: {
        action: "blocked",
        conflicts: [expect.objectContaining({
          code: "identity_conflict",
          field: "external_id.igdb:119133",
          stored: 77,
        })],
      },
    });
  });

  it("returns blocked when the current game gains a different IGDB binding during the write", async () => {
    const state: FakeStoreState = { snapshot: snapshot(), indexedExternalIds: [] };
    const store = fakeStore(state, [], async () => {
      state.snapshot = snapshot(42, ["999999"]);
      throw identityWriteConflict();
    });

    const result = await createIgdbEnricher({ client: clientFor(), store })
      .enrichGame(42, { dryRun: false });

    expect(result).toMatchObject({
      status: "blocked",
      affectedRows: 0,
      plan: {
        action: "blocked",
        conflicts: [expect.objectContaining({
          code: "identity_conflict",
          field: "external_id.igdb",
          stored: "999999",
        })],
      },
    });
  });

  it.each([
    { terminal: "existing", currentIds: [String(igdbGameId)], ownerId: 42 },
    { terminal: "blocked", currentIds: ["999999"], ownerId: null },
  ])("rethrows a generic write conflict even when concurrent state would replan to $terminal", async ({
    currentIds,
    ownerId,
  }) => {
    const state: FakeStoreState = { snapshot: snapshot(), indexedExternalIds: [] };
    const conflict = new IgdbError("write_conflict", "unrelated sanitized write failure", {
      retryable: false,
    });
    let snapshotReads = 0;
    const delegate = fakeStore(state, [], async () => {
      state.snapshot = snapshot(42, currentIds);
      state.indexedExternalIds = ownerId === null
        ? []
        : [externalIdRow(ownerId, "igdb", String(igdbGameId))];
      throw conflict;
    });
    const store: IgdbEnrichmentStore = {
      ...delegate,
      async findSnapshotByGameId(gameId) {
        snapshotReads += 1;
        return delegate.findSnapshotByGameId(gameId);
      },
    };

    await expect(createIgdbEnricher({ client: clientFor(), store })
      .enrichGame(42, { dryRun: false }))
      .rejects.toBe(conflict);
    expect(snapshotReads).toBe(1);
  });

  it("rethrows a classified conflict when an existing replan lacks the same-game IGDB binding", async () => {
    const state: FakeStoreState = { snapshot: snapshot(), indexedExternalIds: [] };
    const conflict = identityWriteConflict();
    let planCalls = 0;
    const store = fakeStore(state, [], async () => {
      throw conflict;
    });
    const dependencies = {
      client: clientFor(),
      store,
      async planEnrichment(...args: Parameters<typeof planIgdbEnrichment>) {
        planCalls += 1;
        const plan = await planIgdbEnrichment(...args);
        if (planCalls === 1) return plan;
        return {
          ...plan,
          action: "existing" as const,
          creates: [],
          updates: [],
          conflicts: [],
        };
      },
    };

    await expect(createIgdbEnricher(dependencies).enrichGame(42, { dryRun: false }))
      .rejects.toBe(conflict);
    expect(planCalls).toBe(2);
  });

  it("rethrows a classified conflict when blocked does not prove either permitted identity outcome", async () => {
    const state: FakeStoreState = { snapshot: snapshot(), indexedExternalIds: [] };
    const conflict = identityWriteConflict();
    let planCalls = 0;
    const store = fakeStore(state, [], async () => {
      throw conflict;
    });
    const dependencies = {
      client: clientFor(),
      store,
      async planEnrichment(...args: Parameters<typeof planIgdbEnrichment>) {
        planCalls += 1;
        const plan = await planIgdbEnrichment(...args);
        if (planCalls === 1) return plan;
        return {
          ...plan,
          action: "blocked" as const,
          creates: [],
          updates: [],
          conflicts: [{
            code: "identity_conflict",
            field: "identity.steamAppId",
            message: "Unrelated identity mismatch",
            incoming: steamAppId,
            stored: "999999",
          }],
        };
      },
    };

    await expect(createIgdbEnricher(dependencies).enrichGame(42, { dryRun: false }))
      .rejects.toBe(conflict);
    expect(planCalls).toBe(2);
  });

  it("does not attempt identity recovery for a write failure when the plan did not create the identity", async () => {
    const state: FakeStoreState = {
      snapshot: snapshot(42, [String(igdbGameId)]),
      indexedExternalIds: [externalIdRow(42, "igdb", String(igdbGameId))],
    };
    const conflict = identityWriteConflict();
    let snapshotReads = 0;
    const delegate = fakeStore(state, [], async () => {
      throw conflict;
    });
    const store: IgdbEnrichmentStore = {
      ...delegate,
      async findSnapshotByGameId(gameId) {
        snapshotReads += 1;
        return delegate.findSnapshotByGameId(gameId);
      },
    };
    const client = clientFor([], mappingBody(), minimalGameBody({ summary: "Incoming summary" }));

    await expect(createIgdbEnricher({ client, store }).enrichGame(42, { dryRun: false }))
      .rejects.toBe(conflict);
    expect(snapshotReads).toBe(1);
  });

  it("does not recover an untyped error even when its message resembles an identity unique constraint", async () => {
    const state: FakeStoreState = { snapshot: snapshot(), indexedExternalIds: [] };
    const conflict = new Error(
      "UNIQUE constraint failed: game_external_ids.provider, game_external_ids.external_id",
    );
    let snapshotReads = 0;
    const delegate = fakeStore(state, [], async () => {
      throw conflict;
    });
    const store: IgdbEnrichmentStore = {
      ...delegate,
      async findSnapshotByGameId(gameId) {
        snapshotReads += 1;
        return delegate.findSnapshotByGameId(gameId);
      },
    };

    await expect(createIgdbEnricher({ client: clientFor(), store })
      .enrichGame(42, { dryRun: false }))
      .rejects.toBe(conflict);
    expect(snapshotReads).toBe(1);
  });
});

describe("createIgdbEnricher on local D1", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  async function localDatabase() {
    const testEnv = await createD1TestBinding();
    disposers.push(testEnv.dispose);
    return {
      binding: testEnv.binding,
      db: createDatabase(testEnv.binding),
    };
  }

  async function tableCounts(db: GameHubDatabase) {
    const rows = await Promise.all([
      db.select().from(games),
      db.select().from(gameExternalIds),
      db.select().from(genres),
      db.select().from(gameGenres),
      db.select().from(platforms),
      db.select().from(gamePlatforms),
      db.select().from(companies),
      db.select().from(gameCompanies),
      db.select().from(gameOfficialLinks),
      db.select().from(gameImages),
      db.select().from(gameVideos),
    ]);
    return rows.map((table) => table.length);
  }

  async function insertCanonicalGame(db: GameHubDatabase) {
    const [game] = await db.insert(games).values({ slug: "elden-ring", title: "Elden Ring" }).returning();
    await db.insert(gameExternalIds).values({
      gameId: game!.id,
      provider: "steam",
      externalId: steamAppId,
    });
    return game!;
  }

  it("reads local D1 and returns an enrichment plan without any dry-run mutation", async () => {
    const { db } = await localDatabase();
    const game = await insertCanonicalGame(db);
    const store = createIgdbEnrichmentStore(db);
    const before = await tableCounts(db);

    const result = await createIgdbEnricher({ client: clientFor(), store })
      .enrichGame(game.id, { dryRun: true });

    expect(result).toMatchObject({
      status: "enrich",
      gameId: game.id,
      dryRun: true,
      affectedRows: 0,
      plan: {
        action: "enrich",
        creates: [expect.objectContaining({ entity: "external_id", key: "igdb:119133" })],
      },
    });
    expect(await tableCounts(db)).toEqual(before);
  });

  it("converges concurrent same-game writes to one identity and no duplicate relations", async () => {
    const { db } = await localDatabase();
    const game = await insertCanonicalGame(db);
    let waitingApplies = 0;
    let releaseApplies!: () => void;
    const bothPlansReachedWrite = new Promise<void>((resolve) => {
      releaseApplies = resolve;
    });
    const racingStore = (): IgdbEnrichmentStore => {
      const delegate = createIgdbEnrichmentStore(db);
      let firstApply = true;
      return {
        ...delegate,
        async applyPlan(plan) {
          if (firstApply) {
            firstApply = false;
            waitingApplies += 1;
            if (waitingApplies === 2) releaseApplies();
            await bothPlansReachedWrite;
          }
          return delegate.applyPlan(plan);
        },
      };
    };
    const gameBody = minimalGameBody({
      genres: [{ id: 12, name: "Role-playing (RPG)", slug: "role-playing-rpg" }],
      platforms: [{ id: 6, name: "PC (Microsoft Windows)", slug: "win" }],
      involved_companies: [{
        developer: true,
        publisher: true,
        company: { id: 101, name: "FromSoftware", slug: "fromsoftware" },
      }],
      websites: [{ type: 1, trusted: true, url: "https://example.test/elden-ring" }],
      videos: [{ video_id: "E3Huy2cdih0", name: "Launch Trailer" }],
    });
    const first = createIgdbEnricher({
      client: clientFor([], mappingBody(), gameBody),
      store: racingStore(),
    });
    const second = createIgdbEnricher({
      client: clientFor([], mappingBody(), gameBody),
      store: racingStore(),
    });

    const results = await Promise.all([
      first.enrichGame(game.id, { dryRun: false }),
      second.enrichGame(game.id, { dryRun: false }),
    ]);

    expect(waitingApplies).toBe(2);
    expect(results.map((result) => result.status).sort()).toEqual(["enrich", "existing"]);
    expect(await db.select().from(gameExternalIds).where(and(
      eq(gameExternalIds.provider, "igdb"),
      eq(gameExternalIds.externalId, String(igdbGameId)),
    ))).toHaveLength(1);
    expect(await tableCounts(db)).toEqual([1, 2, 1, 1, 1, 1, 1, 2, 1, 0, 1]);
  });
});
