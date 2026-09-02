import { and, asc, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import validFixture from "../../test/fixtures/steam/appdetails-valid.json";
import { createD1TestBinding } from "../../test/d1-test-env";
import { createDatabase, type GameHubDatabase } from "../db/client";
import {
  createSteamImportStore,
  type SteamImportSnapshot,
  type SteamImportStore,
} from "../db/repositories/steam-import";
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
import type { SteamClient } from "../providers/steam/client";
import { SteamImportError } from "./errors";
import { createSteamImporter } from "./steam";

const fetchedAt = new Date("2026-09-02T01:02:03.000Z");

function fixtureClient(body: unknown = validFixture): SteamClient {
  return {
    async fetchAppDetails() {
      return {
        body,
        fetchedAt,
        requestUrl: "https://store.steampowered.com/api/appdetails?appids=1245620",
      };
    },
  };
}

function uniqueConstraintError(columns: string): SteamImportError {
  const cause = new Error(`D1_ERROR: UNIQUE constraint failed: ${columns}: SQLITE_CONSTRAINT`);
  return new SteamImportError("write_conflict", `Steam import batch failed: ${cause.message}`, cause);
}

function conservativeFixture(): typeof validFixture {
  const fixture = structuredClone(validFixture);
  const details = fixture["1245620"].data;
  details.name = "Elden Ring: Provider Rename";
  details.short_description = "Provider-owned replacement summary.";
  details.release_date.date = "Mar 1, 2022";
  details.capsule_image = "https://cdn.example.com/elden-ring/new-cover.jpg";
  details.header_image = "https://cdn.example.com/elden-ring/new-hero.jpg";
  details.genres = [{ id: "2", description: "Strategy" }];
  details.developers = ["Different Studio"];
  details.publishers = ["Different Publisher"];
  details.platforms = { windows: false, mac: true, linux: true };
  details.screenshots = [{
    id: 99,
    path_thumbnail: "https://cdn.example.com/elden-ring/new-shot-thumb.jpg",
    path_full: "https://cdn.example.com/elden-ring/new-shot.jpg",
  }];
  details.website = "https://example.com/elden-ring-provider-site";
  return fixture;
}

describe("createSteamImporter", () => {
  function dependencies() {
    let persisted: SteamImportSnapshot | null = null;
    const persistedSnapshot: SteamImportSnapshot = {
      game: {
        id: 42,
        slug: "elden-ring",
        title: "Elden Ring",
        summary: "The new fantasy action RPG.",
        description: null,
        status: "released",
        releaseDate: "2022-02-25",
        coverUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/capsule_616x353.jpg",
        heroUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg",
        createdAt: fetchedAt,
        updatedAt: fetchedAt,
      },
      externalIds: [{
        id: 1,
        gameId: 42,
        provider: "steam",
        externalId: "1245620",
        externalUrl: "https://store.steampowered.com/app/1245620/",
        createdAt: fetchedAt,
        updatedAt: fetchedAt,
      }],
      officialLinks: [],
      genres: [],
      platforms: [],
      companies: [],
      images: [],
      videos: [],
    };
    const findSnapshotByExternalId = vi.fn<SteamImportStore["findSnapshotByExternalId"]>()
      .mockImplementation(async () => persisted);
    const applyPlan = vi.fn<SteamImportStore["applyPlan"]>()
      .mockImplementation(async () => {
        persisted = persistedSnapshot;
      });
    const store: SteamImportStore = {
      findSnapshotByExternalId,
      findGameBySlug: vi.fn().mockResolvedValue(null),
      findGenresBySlugs: vi.fn().mockResolvedValue([]),
      findPlatformsBySlugs: vi.fn().mockResolvedValue([]),
      findCompaniesBySlugs: vi.fn().mockResolvedValue([]),
      applyPlan,
    };
    const client = fixtureClient();

    return { applyPlan, findSnapshotByExternalId, store, client };
  }

  it("returns a predicted create without applying the plan during dry-run", async () => {
    const { applyPlan, store, client } = dependencies();

    const importer = createSteamImporter({ client, store });
    const result = await importer.importGame("001245620", { dryRun: true });

    expect(result).toMatchObject({
      status: "created",
      gameId: null,
      appId: "1245620",
      dryRun: true,
      plan: { action: "create" },
    });
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it("defaults to dry-run and never applies its planned create", async () => {
    const { applyPlan, store, client } = dependencies();

    const result = await createSteamImporter({ client, store }).importGame(1245620);

    expect(result.dryRun).toBe(true);
    expect(applyPlan).not.toHaveBeenCalled();
  });

  it("applies the same plan exactly once when writes are explicitly enabled", async () => {
    const { applyPlan, store, client } = dependencies();

    const result = await createSteamImporter({ client, store }).importGame(1245620, { dryRun: false });

    expect(result).toMatchObject({ status: "created", gameId: 42, dryRun: false });
    expect(applyPlan).toHaveBeenCalledOnce();
    expect(applyPlan).toHaveBeenCalledWith(result.plan);
  });

  it("throws a typed write_incomplete error when the persisted mapping cannot be re-read", async () => {
    const { applyPlan, findSnapshotByExternalId, store, client } = dependencies();
    applyPlan.mockImplementation(async () => undefined);

    await expect(createSteamImporter({ client, store }).importGame(1245620, { dryRun: false }))
      .rejects.toMatchObject({ name: "SteamImportError", code: "write_incomplete" });
    expect(findSnapshotByExternalId).toHaveBeenCalledTimes(2);
  });

  it("replans with the next deterministic slug after a unique-conflict race", async () => {
    const { store, client } = dependencies();
    const persist = store.applyPlan;
    const occupiedSlugs = new Set<string>();
    const attemptedSlugs: string[] = [];
    store.findGameBySlug = vi.fn(async (slug) => occupiedSlugs.has(slug)
      ? { id: 99, slug, title: "Concurrent winner" }
      : null);
    store.applyPlan = vi.fn(async (plan) => {
      attemptedSlugs.push(plan.selectedSlug);
      if (attemptedSlugs.length === 1) {
        occupiedSlugs.add(plan.selectedSlug);
        throw uniqueConstraintError("games.slug");
      }
      await persist(plan);
    });

    const result = await createSteamImporter({ client, store })
      .importGame("1245620", { dryRun: false });

    expect(result).toMatchObject({
      status: "created",
      gameId: 42,
      plan: { action: "create", selectedSlug: "elden-ring-steam-1245620" },
    });
    expect(attemptedSlugs).toEqual(["elden-ring", "elden-ring-steam-1245620"]);
  });

  it("caps unique-conflict race recovery at three retries", async () => {
    const { store, client } = dependencies();
    const occupiedSlugs = new Set<string>();
    const attemptedSlugs: string[] = [];
    store.findGameBySlug = vi.fn(async (slug) => occupiedSlugs.has(slug)
      ? { id: attemptedSlugs.length, slug, title: "Concurrent winner" }
      : null);
    store.applyPlan = vi.fn(async (plan) => {
      attemptedSlugs.push(plan.selectedSlug);
      occupiedSlugs.add(plan.selectedSlug);
      throw uniqueConstraintError("games.slug");
    });

    await expect(createSteamImporter({ client, store })
      .importGame("1245620", { dryRun: false }))
      .rejects.toMatchObject({ name: "SteamImportError", code: "write_conflict" });
    expect(attemptedSlugs).toEqual([
      "elden-ring",
      "elden-ring-steam-1245620",
      "elden-ring-steam-1245620-2",
      "elden-ring-steam-1245620-3",
    ]);
  });

  it("does not recover non-unique database conflicts", async () => {
    const { findSnapshotByExternalId, store, client } = dependencies();
    const conflict = new SteamImportError(
      "write_conflict",
      "Steam import batch failed: D1_ERROR: injected failure",
      new Error("D1_ERROR: injected failure"),
    );
    store.applyPlan = vi.fn(async () => {
      throw conflict;
    });

    await expect(createSteamImporter({ client, store })
      .importGame("1245620", { dryRun: false }))
      .rejects.toBe(conflict);
    expect(findSnapshotByExternalId).toHaveBeenCalledOnce();
  });

  it("rethrows unrelated unique conflicts without retrying", async () => {
    const { findSnapshotByExternalId, store, client } = dependencies();
    const conflict = uniqueConstraintError("game_official_links.game_id, game_official_links.url");
    const applyPlan = vi.fn(async () => {
      throw conflict;
    });
    store.applyPlan = applyPlan;

    await expect(createSteamImporter({ client, store })
      .importGame("1245620", { dryRun: false }))
      .rejects.toBe(conflict);
    expect(applyPlan).toHaveBeenCalledOnce();
    expect(findSnapshotByExternalId).toHaveBeenCalledOnce();
  });

  it("rethrows a bare SQLite primary-key code without retrying", async () => {
    const { findSnapshotByExternalId, store, client } = dependencies();
    const cause = Object.assign(
      new Error("D1_ERROR: constraint failed: SQLITE_CONSTRAINT"),
      { code: "SQLITE_CONSTRAINT_PRIMARYKEY" },
    );
    const conflict = new SteamImportError(
      "write_conflict",
      `Steam import batch failed: ${cause.message}`,
      cause,
    );
    const applyPlan = vi.fn(async () => {
      throw conflict;
    });
    store.applyPlan = applyPlan;

    await expect(createSteamImporter({ client, store })
      .importGame("1245620", { dryRun: false }))
      .rejects.toBe(conflict);
    expect(applyPlan).toHaveBeenCalledOnce();
    expect(findSnapshotByExternalId).toHaveBeenCalledOnce();
  });
});

describe("createSteamImporter on D1", () => {
  let binding: Awaited<ReturnType<typeof createD1TestBinding>>["binding"];
  let db: GameHubDatabase;
  let store: SteamImportStore;
  let dispose: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const testEnv = await createD1TestBinding();
    binding = testEnv.binding;
    dispose = testEnv.dispose;
    db = createDatabase(binding);
    store = createSteamImportStore(db);
  });

  afterEach(async () => dispose?.());

  async function persistedCounts() {
    const rows = await Promise.all([
      db.select().from(games),
      db.select().from(gameExternalIds),
      db.select().from(gameOfficialLinks),
      db.select().from(gameImages),
      db.select().from(gameVideos),
      db.select().from(gameGenres),
      db.select().from(gamePlatforms),
      db.select().from(gameCompanies),
    ]);
    return rows.map((items) => items.length);
  }

  it("creates a new canonical game atomically", async () => {
    const result = await createSteamImporter({ client: fixtureClient(), store })
      .importGame("001245620", { dryRun: false });

    const gameRows = await db.select().from(games);
    expect(gameRows).toHaveLength(1);
    expect(Number.isInteger(gameRows[0]!.id)).toBe(true);
    expect(result).toMatchObject({
      status: "created",
      gameId: gameRows[0]!.id,
      appId: "1245620",
      dryRun: false,
      plan: { action: "create", selectedSlug: "elden-ring" },
    });
    expect(gameRows[0]).toMatchObject({
      slug: "elden-ring",
      title: "Elden Ring",
      summary: "The new fantasy action RPG.",
      description: null,
      status: "released",
      releaseDate: "2022-02-25",
      coverUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/capsule_616x353.jpg",
      heroUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg",
    });

    const snapshot = await store.findSnapshotByExternalId("steam", "1245620");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.externalIds).toHaveLength(1);
    expect(snapshot!.externalIds[0]).toMatchObject({
      gameId: gameRows[0]!.id,
      provider: "steam",
      externalId: "1245620",
      externalUrl: "https://store.steampowered.com/app/1245620/",
    });

    const storeLinks = snapshot!.officialLinks.filter((link) => link.linkType === "store");
    expect(storeLinks).toEqual([expect.objectContaining({
      provider: "steam",
      platform: null,
      url: "https://store.steampowered.com/app/1245620/",
      isOfficial: true,
      verificationStatus: "verified",
      verificationMethod: "provider_api",
    })]);
    expect(snapshot!.officialLinks).toContainEqual(expect.objectContaining({
      provider: "steam",
      platform: null,
      linkType: "official_website",
      url: "https://en.bandainamcoent.eu/elden-ring/elden-ring",
      isOfficial: true,
      verificationStatus: "unverified",
      verificationMethod: null,
    }));

    expect(snapshot!.genres).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "rpg", name: "RPG" }),
      expect.objectContaining({ slug: "action", name: "Action" }),
    ]));
    expect(snapshot!.genres).toHaveLength(2);
    expect(snapshot!.platforms).toEqual([expect.objectContaining({ slug: "windows", name: "Windows" })]);
    expect(snapshot!.companies).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: "fromsoftware", name: "FromSoftware", role: "developer" }),
      expect.objectContaining({ slug: "fromsoftware", name: "FromSoftware", role: "publisher" }),
      expect.objectContaining({ slug: "bandai-namco-entertainment", name: "Bandai Namco Entertainment", role: "publisher" }),
    ]));
    expect(snapshot!.companies).toHaveLength(3);

    const [genreJunctions, platformJunctions, companyJunctions] = await Promise.all([
      db.select().from(gameGenres).where(eq(gameGenres.gameId, gameRows[0]!.id)),
      db.select().from(gamePlatforms).where(eq(gamePlatforms.gameId, gameRows[0]!.id)),
      db.select().from(gameCompanies).where(eq(gameCompanies.gameId, gameRows[0]!.id)),
    ]);
    expect(genreJunctions).toHaveLength(2);
    expect(platformJunctions).toHaveLength(1);
    expect(companyJunctions).toHaveLength(3);

    expect([...snapshot!.images].sort((left, right) => left.sortOrder - right.sortOrder)).toEqual([
      expect.objectContaining({
        type: "cover",
        sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/capsule_616x353.jpg",
        storageUrl: null,
        sortOrder: 0,
      }),
      expect.objectContaining({
        type: "hero",
        sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg",
        storageUrl: null,
        sortOrder: 1,
      }),
      expect.objectContaining({
        type: "screenshot",
        sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/ss_1.jpg",
        storageUrl: null,
        sortOrder: 2,
      }),
      expect.objectContaining({
        type: "screenshot",
        sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/ss_2.jpg",
        storageUrl: null,
        sortOrder: 3,
      }),
    ]);
    expect(snapshot!.videos).toEqual([expect.objectContaining({
      provider: "steam",
      externalId: "256878122",
      title: "ELDEN RING Official Gameplay Reveal",
      thumbnailUrl: "https://cdn.akamai.steamstatic.com/steam/apps/256878122/movie.293x165.jpg",
      sortOrder: 0,
    })]);
    expect(snapshot!.videos[0]).not.toHaveProperty("storageUrl");
  });

  it("returns existing for an identical second import without growing any owned rows", async () => {
    const importer = createSteamImporter({ client: fixtureClient(), store });
    const created = await importer.importGame("1245620", { dryRun: false });
    const countsAfterCreate = await persistedCounts();
    const snapshotAfterCreate = await store.findSnapshotByExternalId("steam", "1245620");

    const existing = await importer.importGame("1245620", { dryRun: false });

    expect(created.status).toBe("created");
    expect(existing).toMatchObject({
      status: "existing",
      gameId: created.gameId,
      plan: { action: "existing", updates: [] },
    });
    expect(await persistedCounts()).toEqual(countsAfterCreate);
    expect(await store.findSnapshotByExternalId("steam", "1245620"))
      .toEqual(snapshotAfterCreate);
  });

  it("recovers an external-ID conflict by returning the concurrent winning game", async () => {
    const winnerStore = createSteamImportStore(db);
    const appliedActions: string[] = [];
    let injected = false;
    const racingStore: SteamImportStore = {
      ...store,
      async applyPlan(plan) {
        appliedActions.push(plan.action);
        if (!injected && plan.action === "create") {
          injected = true;
          await winnerStore.applyPlan(plan);
          throw uniqueConstraintError("game_external_ids.provider, game_external_ids.external_id");
        }
        await store.applyPlan(plan);
      },
    };

    const result = await createSteamImporter({ client: fixtureClient(), store: racingStore })
      .importGame("1245620", { dryRun: false });
    const [winner] = await db.select().from(games);

    expect(result).toMatchObject({
      status: "existing",
      gameId: winner!.id,
      plan: { action: "existing", existingGameId: winner!.id },
    });
    expect(appliedActions).toEqual(["create", "existing"]);
    expect(await db.select().from(games)).toHaveLength(1);
    expect(await db.select().from(gameExternalIds).where(and(
      eq(gameExternalIds.provider, "steam"),
      eq(gameExternalIds.externalId, "1245620"),
    ))).toHaveLength(1);
  });

  it("keeps concurrent same-App-ID imports idempotent", async () => {
    let initialMissingReads = 0;
    let releaseInitialReads!: () => void;
    const bothInitialReadsCompleted = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const createRacingStore = (): SteamImportStore => {
      const delegate = createSteamImportStore(db);
      let isInitialExternalIdRead = true;
      return {
        ...delegate,
        async findSnapshotByExternalId(provider, externalId) {
          const snapshot = await delegate.findSnapshotByExternalId(provider, externalId);
          if (isInitialExternalIdRead) {
            isInitialExternalIdRead = false;
            expect(snapshot).toBeNull();
            initialMissingReads += 1;
            if (initialMissingReads === 2) releaseInitialReads();
            await bothInitialReadsCompleted;
          }
          return snapshot;
        },
      };
    };
    const firstImporter = createSteamImporter({
      client: fixtureClient(),
      store: createRacingStore(),
    });
    const secondImporter = createSteamImporter({
      client: fixtureClient(),
      store: createRacingStore(),
    });

    const [first, second] = await Promise.all([
      firstImporter.importGame("1245620", { dryRun: false }),
      secondImporter.importGame("1245620", { dryRun: false }),
    ]);

    expect(initialMissingReads).toBe(2);
    expect([first.status, second.status].sort()).toEqual(["created", "existing"]);
    expect(first.gameId).toBe(second.gameId);
    expect(await persistedCounts()).toEqual([1, 1, 2, 4, 1, 2, 1, 3]);
    expect(await db.select().from(gameExternalIds).where(and(
      eq(gameExternalIds.provider, "steam"),
      eq(gameExternalIds.externalId, "1245620"),
    ))).toHaveLength(1);
  });

  it("returns updated and persists exactly the approved Steam-owned metadata", async () => {
    const importer = createSteamImporter({ client: fixtureClient(), store });
    const created = await importer.importGame("1245620", { dryRun: false });
    const gameId = created.gameId!;
    const storeUrl = "https://store.steampowered.com/app/1245620/";
    await db.update(gameExternalIds)
      .set({ externalUrl: "https://store.steampowered.com/old/1245620" })
      .where(eq(gameExternalIds.gameId, gameId));
    await db.update(gameOfficialLinks)
      .set({ isOfficial: false, verificationStatus: "unverified", verificationMethod: null })
      .where(eq(gameOfficialLinks.url, storeUrl));
    await db.update(gameVideos)
      .set({ title: "Old imported title", thumbnailUrl: "https://cdn.example.com/old-thumbnail.jpg" })
      .where(eq(gameVideos.gameId, gameId));

    const result = await importer.importGame("1245620", { dryRun: false });

    expect(result).toMatchObject({ status: "updated", gameId, plan: { action: "update" } });
    expect(result.plan.updates).toEqual([
      {
        entity: "external_id",
        key: "steam:1245620",
        changes: { externalUrl: storeUrl },
      },
      {
        entity: "official_link",
        key: storeUrl,
        changes: {
          isOfficial: true,
          verificationStatus: "verified",
          verificationMethod: "provider_api",
        },
      },
      {
        entity: "video",
        key: "steam:256878122",
        changes: {
          title: "ELDEN RING Official Gameplay Reveal",
          thumbnailUrl: "https://cdn.akamai.steamstatic.com/steam/apps/256878122/movie.293x165.jpg",
        },
      },
    ]);
    const persisted = await store.findSnapshotByExternalId("steam", "1245620");
    expect(persisted!.externalIds[0]!.externalUrl).toBe(storeUrl);
    expect(persisted!.officialLinks.find((link) => link.url === storeUrl)).toMatchObject({
      isOfficial: true,
      verificationStatus: "verified",
      verificationMethod: "provider_api",
    });
    expect(persisted!.videos[0]).toMatchObject({
      title: "ELDEN RING Official Gameplay Reveal",
      thumbnailUrl: "https://cdn.akamai.steamstatic.com/steam/apps/256878122/movie.293x165.jpg",
    });
  });

  it("does not apply a planned Store verification update after the row becomes platform-specific", async () => {
    const importer = createSteamImporter({ client: fixtureClient(), store });
    const created = await importer.importGame("1245620", { dryRun: false });
    const storeUrl = "https://store.steampowered.com/app/1245620/";
    const staleVerification = {
      isOfficial: false,
      verificationStatus: "unverified",
      verificationMethod: null,
    } as const;
    await db.update(gameOfficialLinks)
      .set(staleVerification)
      .where(eq(gameOfficialLinks.url, storeUrl));
    const planned = await importer.importGame("1245620", { dryRun: true });
    expect(planned).toMatchObject({
      status: "updated",
      gameId: created.gameId,
      plan: { action: "update" },
    });
    await db.update(gameOfficialLinks)
      .set({ platform: "windows" })
      .where(eq(gameOfficialLinks.url, storeUrl));

    await store.applyPlan(planned.plan);

    expect((await store.findSnapshotByExternalId("steam", "1245620"))!.officialLinks
      .find((link) => link.url === storeUrl)).toMatchObject({
        platform: "windows",
        ...staleVerification,
      });
  });

  it("keeps conservative provider differences as explicit skips and leaves stored rows unchanged", async () => {
    const created = await createSteamImporter({ client: fixtureClient(), store })
      .importGame("1245620", { dryRun: false });
    const before = await store.findSnapshotByExternalId("steam", "1245620");
    const beforeCounts = await persistedCounts();

    const result = await createSteamImporter({ client: fixtureClient(conservativeFixture()), store })
      .importGame("1245620", { dryRun: false });

    expect(result).toMatchObject({
      status: "existing",
      gameId: created.gameId,
      plan: { action: "existing", updates: [] },
    });
    expect(result.plan.skips).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "game.title" }),
      expect.objectContaining({ field: "game.summary" }),
      expect.objectContaining({ field: "game.releaseDate" }),
      expect.objectContaining({ field: "game.coverUrl" }),
      expect.objectContaining({ field: "game.heroUrl" }),
      expect.objectContaining({ field: "game.genre.strategy" }),
      expect.objectContaining({ field: "game.platform.macos" }),
      expect.objectContaining({ field: "game.platform.linux" }),
      expect.objectContaining({ field: "game.company.different-studio:developer" }),
      expect.objectContaining({ field: "game.company.different-publisher:publisher" }),
      expect.objectContaining({ field: "image.https://cdn.example.com/elden-ring/new-cover.jpg" }),
      expect.objectContaining({ field: "image.https://cdn.example.com/elden-ring/new-hero.jpg" }),
      expect.objectContaining({ field: "image.https://cdn.example.com/elden-ring/new-shot.jpg" }),
      expect.objectContaining({ field: "official_link.https://example.com/elden-ring-provider-site" }),
    ]));
    expect(await persistedCounts()).toEqual(beforeCounts);
    expect(await store.findSnapshotByExternalId("steam", "1245620")).toEqual(before);
  });

  it("rolls back every approved updated field when one statement in the D1 batch fails", async () => {
    const importer = createSteamImporter({ client: fixtureClient(), store });
    const created = await importer.importGame("1245620", { dryRun: false });
    const gameId = created.gameId!;
    const storeUrl = "https://store.steampowered.com/app/1245620/";
    const stale = {
      externalUrl: "https://store.steampowered.com/old/1245620",
      title: "Old imported title",
    };
    await db.update(gameExternalIds).set({ externalUrl: stale.externalUrl }).where(eq(gameExternalIds.gameId, gameId));
    await db.update(gameOfficialLinks)
      .set({ isOfficial: false, verificationStatus: "unverified", verificationMethod: null })
      .where(eq(gameOfficialLinks.url, storeUrl));
    await db.update(gameVideos).set({ title: stale.title }).where(eq(gameVideos.gameId, gameId));
    await binding.prepare(`
      CREATE TRIGGER fail_steam_video_update
      BEFORE UPDATE ON game_videos
      BEGIN
        SELECT RAISE(ABORT, 'injected steam video update failure');
      END
    `).run();

    try {
      await expect(importer.importGame("1245620", { dryRun: false }))
        .rejects.toThrow("injected steam video update failure");
      const persisted = await store.findSnapshotByExternalId("steam", "1245620");
      expect(persisted!.externalIds[0]!.externalUrl).toBe(stale.externalUrl);
      expect(persisted!.officialLinks.find((link) => link.url === storeUrl)).toMatchObject({
        isOfficial: false,
        verificationStatus: "unverified",
        verificationMethod: null,
      });
      expect(persisted!.videos[0]!.title).toBe(stale.title);
    } finally {
      await binding.prepare("DROP TRIGGER IF EXISTS fail_steam_video_update").run();
    }
  });

  it("rolls back the entire D1 batch after a mid-batch failure", async () => {
    await db.insert(genres).values({ slug: "shared-genre", name: "Shared Genre" });
    await db.insert(platforms).values({ slug: "shared-platform", name: "Shared Platform" });
    await db.insert(companies).values({ slug: "shared-company", name: "Shared Company" });

    const beforeLookups = {
      genres: await db.select().from(genres).orderBy(asc(genres.id)),
      platforms: await db.select().from(platforms).orderBy(asc(platforms.id)),
      companies: await db.select().from(companies).orderBy(asc(companies.id)),
    };
    await binding.prepare(`
      CREATE TRIGGER fail_steam_image_insert
      BEFORE INSERT ON game_images
      BEGIN
        SELECT RAISE(ABORT, 'injected steam image failure');
      END
    `).run();

    try {
      await expect(createSteamImporter({ client: fixtureClient(), store })
        .importGame("1245620", { dryRun: false }))
        .rejects.toThrow("injected steam image failure");

      expect(await db.select().from(games)).toEqual([]);
      expect(await db.select().from(gameExternalIds)).toEqual([]);
      expect(await db.select().from(gameOfficialLinks)).toEqual([]);
      expect(await db.select().from(gameGenres)).toEqual([]);
      expect(await db.select().from(gamePlatforms)).toEqual([]);
      expect(await db.select().from(gameCompanies)).toEqual([]);
      expect(await db.select().from(gameImages)).toEqual([]);
      expect(await db.select().from(gameVideos)).toEqual([]);

      expect(await db.select().from(genres).orderBy(asc(genres.id))).toEqual(beforeLookups.genres);
      expect(await db.select().from(platforms).orderBy(asc(platforms.id))).toEqual(beforeLookups.platforms);
      expect(await db.select().from(companies).orderBy(asc(companies.id))).toEqual(beforeLookups.companies);
      expect(await db.select().from(genres).where(inArray(genres.slug, ["rpg", "action"]))).toEqual([]);
      expect(await db.select().from(platforms).where(eq(platforms.slug, "windows"))).toEqual([]);
      expect(await db.select().from(companies).where(inArray(companies.slug, [
        "fromsoftware",
        "bandai-namco-entertainment",
      ]))).toEqual([]);
    } finally {
      await binding.prepare("DROP TRIGGER IF EXISTS fail_steam_image_insert").run();
    }
  });
});
