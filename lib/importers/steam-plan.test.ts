import { describe, expect, it } from "vitest";
import validFixture from "../../test/fixtures/steam/appdetails-valid.json";
import type {
  IndexedCompany,
  IndexedTaxonomy,
  SteamImportSnapshot,
  SteamImportStore,
} from "../db/repositories/steam-import";
import { normalizeSteamGame } from "../providers/steam/normalize";
import { parseSteamAppDetails } from "../providers/steam/response";
import { planSteamImport } from "./steam-plan";

const fetchedAt = new Date("2026-09-02T01:02:03.000Z");

function normalizedGame() {
  return normalizeSteamGame(
    parseSteamAppDetails(validFixture, "1245620"),
    "1245620",
    fetchedAt,
  );
}

function fakeStore(options: {
  gamesBySlug?: Record<string, { id: number; slug: string; title: string }>;
  snapshot?: SteamImportSnapshot | null;
  genres?: IndexedTaxonomy[];
  platforms?: IndexedTaxonomy[];
  companies?: IndexedCompany[];
} = {}) {
  const reads: string[] = [];
  let writes = 0;
  const gamesBySlug = options.gamesBySlug ?? {};

  const store: SteamImportStore = {
    async findSnapshotByExternalId() {
      reads.push("external-id");
      return options.snapshot ?? null;
    },
    async findGameBySlug(slug) {
      reads.push(`slug:${slug}`);
      return gamesBySlug[slug] ?? null;
    },
    async findGenresBySlugs() {
      reads.push("genres");
      return options.genres ?? [];
    },
    async findPlatformsBySlugs() {
      reads.push("platforms");
      return options.platforms ?? [];
    },
    async findCompaniesBySlugs() {
      reads.push("companies");
      return options.companies ?? [];
    },
    async applyPlan() {
      writes += 1;
    },
  };

  return { store, reads, get writes() { return writes; } };
}

function matchingSnapshot(): SteamImportSnapshot {
  const candidate = normalizedGame().candidate;
  const now = new Date("2026-09-02T01:02:03.000Z");
  return {
    game: {
      id: 42,
      slug: "elden-ring",
      title: candidate.game.title,
      summary: candidate.game.summary,
      description: candidate.game.description,
      status: candidate.game.status,
      releaseDate: candidate.game.releaseDate,
      coverUrl: candidate.game.coverUrl,
      heroUrl: candidate.game.heroUrl,
      createdAt: now,
      updatedAt: now,
    },
    externalIds: candidate.externalIds.map((item, index) => ({
      id: index + 1,
      gameId: 42,
      provider: item.provider,
      externalId: item.externalId,
      externalUrl: item.externalUrl,
      createdAt: now,
      updatedAt: now,
    })),
    officialLinks: candidate.officialLinks.map((item, index) => ({
      id: index + 1,
      gameId: 42,
      provider: item.provider,
      platform: item.platform,
      linkType: item.linkType,
      url: item.url,
      region: null,
      isOfficial: item.isOfficial,
      verificationStatus: item.verificationStatus,
      verificationMethod: item.verificationMethod,
      httpStatus: null,
      redirectUrl: null,
      verifiedAt: null,
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now,
    })),
    genres: candidate.genres.map((item, index) => ({ id: index + 1, ...item })),
    platforms: candidate.platforms.map((item, index) => ({ id: index + 1, ...item })),
    companies: candidate.companies.map((item, index) => ({
      id: index + 1,
      slug: item.preferredSlug,
      name: item.name,
      role: item.role,
    })),
    images: candidate.images.map((item, index) => ({
      id: index + 1,
      gameId: 42,
      ...item,
      storageUrl: null,
      createdAt: now,
    })),
    videos: candidate.videos.map((item, index) => ({
      id: index + 1,
      gameId: 42,
      ...item,
      createdAt: now,
    })),
  };
}

describe("planSteamImport", () => {
  it("plans a create for a missing Steam external ID and preserves every normalization warning", async () => {
    const fake = fakeStore();
    const normalized = normalizedGame();

    const plan = await planSteamImport(fake.store, normalized);

    expect(plan).toMatchObject({
      action: "create",
      selectedSlug: "elden-ring",
      existingGameId: null,
      candidate: normalized.candidate,
      warnings: normalized.warnings,
    });
    expect(plan.creates).toContainEqual({ entity: "game", key: "elden-ring" });
    expect(fake.writes).toBe(0);
  });

  it("uses the Steam App ID fallback and warns when the preferred slug is occupied", async () => {
    const occupant = { id: 88, slug: "elden-ring", title: "A Different Elden Ring" };
    const fake = fakeStore({ gamesBySlug: { "elden-ring": occupant } });

    const plan = await planSteamImport(fake.store, normalizedGame());

    expect(plan.selectedSlug).toBe("elden-ring-steam-1245620");
    expect(plan.warnings).toContainEqual(expect.objectContaining({
      code: "possible_duplicate",
      message: expect.stringContaining("88"),
    }));
    expect(plan.warnings.find((warning) => warning.code === "possible_duplicate")?.message)
      .toContain("elden-ring");
  });

  it("adds a numeric suffix when the first Steam App ID fallback is occupied", async () => {
    const fake = fakeStore({
      gamesBySlug: {
        "elden-ring": { id: 88, slug: "elden-ring", title: "A Different Elden Ring" },
        "elden-ring-steam-1245620": { id: 89, slug: "elden-ring-steam-1245620", title: "Another Game" },
      },
    });

    const plan = await planSteamImport(fake.store, normalizedGame());

    expect(plan.selectedSlug).toBe("elden-ring-steam-1245620-2");
    expect(plan.warnings.filter((warning) => warning.code === "possible_duplicate")).toHaveLength(1);
  });

  it("plans through only indexed external-ID, slug, and taxonomy lookups", async () => {
    const fake = fakeStore();

    await planSteamImport(fake.store, normalizedGame());

    expect(fake.reads).toEqual([
      "external-id",
      "slug:elden-ring",
      "genres",
      "platforms",
      "companies",
    ]);
  });

  it("rejects a stored taxonomy name that contradicts an incoming slug", async () => {
    const fake = fakeStore({
      genres: [{ id: 1, slug: "rpg", name: "Racing" }],
    });

    await expect(planSteamImport(fake.store, normalizedGame())).rejects.toMatchObject({
      code: "taxonomy_conflict",
    });
  });

  it("uses a deterministic collision slug for a different company occupying the base slug", async () => {
    const fake = fakeStore({
      companies: [{ id: 1, slug: "fromsoftware", name: "From Software Consulting" }],
    });

    const plan = await planSteamImport(fake.store, normalizedGame());

    const fromSoftware = plan.resolvedCompanies.filter((company) => company.name === "FromSoftware");
    expect(fromSoftware).toHaveLength(2);
    expect(fromSoftware[0]!.slug).toMatch(/^fromsoftware-[a-f0-9]{8}$/);
    expect(fromSoftware[1]!.slug).toBe(fromSoftware[0]!.slug);
  });

  it("marks an exact indexed snapshot existing and a provider-owned metadata delta update", async () => {
    const snapshot = matchingSnapshot();
    const taxonomies = {
      genres: snapshot.genres,
      platforms: snapshot.platforms,
      companies: snapshot.companies.map(({ id, slug, name }) => ({ id, slug, name })),
    };
    const existing = await planSteamImport(fakeStore({ snapshot, ...taxonomies }).store, normalizedGame());
    expect(existing).toMatchObject({ action: "existing", existingGameId: 42, creates: [], updates: [] });

    const changedSnapshot = matchingSnapshot();
    changedSnapshot.videos[0]!.title = "Old imported title";
    const update = await planSteamImport(fakeStore({ snapshot: changedSnapshot, ...taxonomies }).store, normalizedGame());
    expect(update.action).toBe("update");
    expect(update.updates).toContainEqual(expect.objectContaining({
      entity: "video",
      key: "steam:256878122",
      changes: expect.objectContaining({ title: "ELDEN RING Official Gameplay Reveal" }),
    }));
  });

  it("keeps conservative differences on an existing game as explicit skips", async () => {
    const catalog = matchingSnapshot();
    const snapshot = matchingSnapshot();
    snapshot.officialLinks = [snapshot.officialLinks[0]!];
    snapshot.genres = [];
    snapshot.platforms = [];
    snapshot.companies = [];
    snapshot.images = [{ ...snapshot.images[0]!, sortOrder: 99 }];
    snapshot.videos = [];
    const plan = await planSteamImport(fakeStore({
      snapshot,
      genres: catalog.genres,
      platforms: catalog.platforms,
      companies: catalog.companies.map(({ id, slug, name }) => ({ id, slug, name })),
    }).store, normalizedGame());

    expect(plan).toMatchObject({ action: "existing", creates: [], updates: [] });
    expect(plan.skips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "official_link.https://en.bandainamcoent.eu/elden-ring/elden-ring",
      }),
      expect.objectContaining({ field: "game.genre.rpg" }),
      expect.objectContaining({ field: "game.platform.windows" }),
      expect.objectContaining({ field: "game.company.fromsoftware:developer" }),
      expect.objectContaining({
        field: "image.https://cdn.akamai.steamstatic.com/steam/apps/1245620/capsule_616x353.jpg.sortOrder",
      }),
      expect.objectContaining({
        field: "image.https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg",
      }),
      expect.objectContaining({ field: "video.steam:256878122" }),
    ]));
  });

  it("updates only matched Steam external, canonical Store verification, and video metadata", async () => {
    const snapshot = matchingSnapshot();
    snapshot.externalIds[0]!.externalUrl = "https://store.steampowered.com/old/1245620";
    Object.assign(snapshot.officialLinks[0]!, {
      isOfficial: false,
      verificationStatus: "unverified",
      verificationMethod: null,
    });
    snapshot.officialLinks[1]!.verificationStatus = "failed";
    snapshot.videos[0]!.title = "Old imported title";
    const plan = await planSteamImport(fakeStore({
      snapshot,
      genres: snapshot.genres,
      platforms: snapshot.platforms,
      companies: snapshot.companies.map(({ id, slug, name }) => ({ id, slug, name })),
    }).store, normalizedGame());

    expect(plan.action).toBe("update");
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([
      {
        entity: "external_id",
        key: "steam:1245620",
        changes: { externalUrl: "https://store.steampowered.com/app/1245620/" },
      },
      {
        entity: "official_link",
        key: "https://store.steampowered.com/app/1245620/",
        changes: {
          isOfficial: true,
          verificationStatus: "verified",
          verificationMethod: "provider_api",
        },
      },
      {
        entity: "video",
        key: "steam:256878122",
        changes: { title: "ELDEN RING Official Gameplay Reveal" },
      },
    ]);
    expect(plan.skips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "official_link.https://en.bandainamcoent.eu/elden-ring/elden-ring.verificationStatus",
      }),
    ]));
  });

  it("skips canonical-URL verification changes when the stored link is not a Store link", async () => {
    const snapshot = matchingSnapshot();
    Object.assign(snapshot.officialLinks[0]!, {
      linkType: "purchase",
      isOfficial: false,
      verificationStatus: "unverified",
      verificationMethod: null,
    });
    const plan = await planSteamImport(fakeStore({
      snapshot,
      genres: snapshot.genres,
      platforms: snapshot.platforms,
      companies: snapshot.companies.map(({ id, slug, name }) => ({ id, slug, name })),
    }).store, normalizedGame());

    expect(plan).toMatchObject({ action: "existing", creates: [], updates: [] });
    expect(plan.skips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "official_link.https://store.steampowered.com/app/1245620/.linkType",
      }),
      expect.objectContaining({
        field: "official_link.https://store.steampowered.com/app/1245620/.verificationStatus",
      }),
      expect.objectContaining({
        field: "official_link.https://store.steampowered.com/app/1245620/.verificationMethod",
      }),
    ]));
  });

  it("skips canonical-URL verification changes when the stored provider is not Steam", async () => {
    const snapshot = matchingSnapshot();
    Object.assign(snapshot.officialLinks[0]!, {
      provider: "legacy",
      isOfficial: false,
      verificationStatus: "unverified",
      verificationMethod: null,
    });
    const plan = await planSteamImport(fakeStore({
      snapshot,
      genres: snapshot.genres,
      platforms: snapshot.platforms,
      companies: snapshot.companies.map(({ id, slug, name }) => ({ id, slug, name })),
    }).store, normalizedGame());

    expect(plan).toMatchObject({ action: "existing", creates: [], updates: [] });
    expect(plan.skips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "official_link.https://store.steampowered.com/app/1245620/.provider",
      }),
      expect.objectContaining({
        field: "official_link.https://store.steampowered.com/app/1245620/.verificationStatus",
      }),
      expect.objectContaining({
        field: "official_link.https://store.steampowered.com/app/1245620/.verificationMethod",
      }),
    ]));
  });
});
