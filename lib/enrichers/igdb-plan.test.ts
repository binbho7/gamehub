import { describe, expect, it } from "vitest";
import type {
  IgdbEnrichmentSnapshot,
  IgdbEnrichmentStore,
} from "../db/repositories/igdb-enrichment";
import { IgdbError } from "../providers/igdb/errors";
import type { IgdbNormalizationResult } from "./igdb-candidate";
import { planIgdbEnrichment } from "./igdb-plan";

const now = new Date("2026-09-03T01:02:03.000Z");

function normalization(): IgdbNormalizationResult {
  return {
    candidate: {
      source: { provider: "igdb", externalId: "119133", fetchedAt: now },
      identity: {
        canonicalGameId: 42,
        steamAppId: "1245620",
        igdbGameId: "119133",
      },
      game: {
        title: "Elden Ring",
        summary: "An action role-playing game.",
        description: "Brandish the power of the Elden Ring.",
        releaseDate: "2022-02-25",
        coverUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co4jni.jpg",
        heroUrl: "https://images.igdb.com/igdb/image/upload/t_1080p/ar1x9v.jpg",
      },
      externalIds: [{ provider: "igdb", externalId: "119133", externalUrl: null }],
      genres: [],
      platforms: [],
      companies: [],
      officialLinks: [],
      images: [],
      videos: [],
    },
    warnings: [{ code: "invalid_optional_item", message: "Ignored invalid item", path: "genres[1]" }],
  };
}

function externalIdRow(gameId = 42, externalId = "119133") {
  return {
    id: gameId,
    gameId,
    provider: "igdb",
    externalId,
    externalUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

function matchingSnapshot(result = normalization()): IgdbEnrichmentSnapshot {
  const { candidate } = result;
  return {
    game: {
      id: 42,
      slug: "elden-ring",
      title: candidate.game.title!,
      summary: candidate.game.summary,
      description: candidate.game.description,
      status: "released",
      releaseDate: candidate.game.releaseDate,
      coverUrl: candidate.game.coverUrl,
      heroUrl: candidate.game.heroUrl,
      createdAt: now,
      updatedAt: now,
    },
    steamAppId: "1245620",
    externalIds: [externalIdRow()],
    officialLinks: [],
    genres: [],
    platforms: [],
    companies: [],
    images: [],
    videos: [],
  };
}

type StoreRows = {
  externalIds?: Awaited<ReturnType<IgdbEnrichmentStore["findExternalIdsByProvider"]>>;
  genres?: Awaited<ReturnType<IgdbEnrichmentStore["findGenresBySlugs"]>>;
  platforms?: Awaited<ReturnType<IgdbEnrichmentStore["findPlatformsBySlugs"]>>;
  companies?: Awaited<ReturnType<IgdbEnrichmentStore["findCompaniesBySlugs"]>>;
  images?: Awaited<ReturnType<IgdbEnrichmentStore["findImagesBySourceUrls"]>>;
  videos?: Awaited<ReturnType<IgdbEnrichmentStore["findVideosByProviderAndExternalIds"]>>;
  officialLinks?: Awaited<ReturnType<IgdbEnrichmentStore["findOfficialLinksByUrls"]>>;
};

function fakeStore(rows: StoreRows = {}): IgdbEnrichmentStore {
  return {
    async applyPlan() {
      throw new Error("The planner must not write");
    },
    async findSnapshotByGameId() {
      throw new Error("The planner must use the supplied snapshot");
    },
    async findExternalIdsByProvider(provider, externalIds) {
      return (rows.externalIds ?? []).filter((row) => (
        row.provider === provider && externalIds.includes(row.externalId)
      ));
    },
    async findGenresBySlugs(slugs) {
      return (rows.genres ?? []).filter((row) => slugs.includes(row.slug));
    },
    async findGenresByNames(names: string[]) {
      return (rows.genres ?? []).filter((row) => names.includes(row.name));
    },
    async findPlatformsBySlugs(slugs) {
      return (rows.platforms ?? []).filter((row) => slugs.includes(row.slug));
    },
    async findPlatformsByNames(names: string[]) {
      return (rows.platforms ?? []).filter((row) => names.includes(row.name));
    },
    async findCompaniesBySlugs(slugs) {
      return (rows.companies ?? []).filter((row) => slugs.includes(row.slug));
    },
    async findImagesBySourceUrls(gameId, sourceUrls) {
      return (rows.images ?? []).filter((row) => (
        row.gameId === gameId && sourceUrls.includes(row.sourceUrl)
      ));
    },
    async findVideosByProviderAndExternalIds(gameId, provider, externalIds) {
      return (rows.videos ?? []).filter((row) => (
        row.gameId === gameId && row.provider === provider && externalIds.includes(row.externalId)
      ));
    },
    async findOfficialLinksByUrls(gameId, urls) {
      return (rows.officialLinks ?? []).filter((row) => (
        row.gameId === gameId && urls.includes(row.url)
      ));
    },
  };
}

describe("planIgdbEnrichment", () => {
  it("fills only null canonical scalars and preserves title and populated mismatches", async () => {
    const normalized = normalization();
    const snapshot = matchingSnapshot(normalized);
    snapshot.game.title = "Canonical Elden Ring";
    snapshot.game.summary = null;
    snapshot.game.description = "Curated description";
    snapshot.game.releaseDate = null;
    snapshot.game.heroUrl = null;

    const plan = await planIgdbEnrichment(
      fakeStore({ externalIds: [externalIdRow()] }),
      snapshot,
      normalized,
    );

    expect(plan.action).toBe("enrich");
    expect(plan.updates).toEqual([{
      entity: "game",
      key: "42",
      changes: {
        summary: "An action role-playing game.",
        releaseDate: "2022-02-25",
        heroUrl: "https://images.igdb.com/igdb/image/upload/t_1080p/ar1x9v.jpg",
      },
    }]);
    expect(plan.skips).toEqual([
      {
        field: "game.title",
        reason: "ownership_unknown",
        incoming: "Elden Ring",
        stored: "Canonical Elden Ring",
      },
      {
        field: "game.description",
        reason: "ownership_unknown",
        incoming: "Brandish the power of the Elden Ring.",
        stored: "Curated description",
      },
    ]);
    expect(plan.updates[0]!.changes).not.toHaveProperty("title");
    expect(plan.warnings).toEqual(normalized.warnings);
  });

  it("treats exact canonical scalar values as an existing no-op", async () => {
    const normalized = normalization();
    const plan = await planIgdbEnrichment(
      fakeStore({ externalIds: [externalIdRow()] }),
      matchingSnapshot(normalized),
      normalized,
    );

    expect(plan.action).toBe("existing");
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.skips).toEqual([]);
  });

  it("plans the complete IGDB identity create and treats an exact binding as idempotent", async () => {
    const normalized = normalization();
    const missingIdentity = matchingSnapshot(normalized);
    missingIdentity.externalIds = [];

    const planWithWrite = await planIgdbEnrichment(fakeStore(), missingIdentity, normalized);
    const noAllowedChange = await planIgdbEnrichment(
      fakeStore({ externalIds: [externalIdRow()] }),
      matchingSnapshot(normalized),
      normalized,
    );

    expect(planWithWrite.action).toBe("enrich");
    expect(planWithWrite.creates).toEqual([{
      entity: "external_id",
      key: "igdb:119133",
      values: {
        gameId: 42,
        provider: "igdb",
        externalId: "119133",
        externalUrl: null,
      },
    }]);
    expect(noAllowedChange.action).toBe("existing");
    expect(noAllowedChange.creates).toEqual([]);
  });

  it("blocks when the current canonical game has a different IGDB identity", async () => {
    const normalized = normalization();
    const snapshot = matchingSnapshot(normalized);
    snapshot.externalIds = [externalIdRow(42, "999999")];

    const identityConflict = await planIgdbEnrichment(fakeStore(), snapshot, normalized);

    expect(identityConflict.action).toBe("blocked");
    expect(identityConflict.creates).toEqual([]);
    expect(identityConflict.updates).toEqual([]);
    expect(identityConflict.conflicts).toEqual([expect.objectContaining({
      code: "identity_conflict",
      field: "external_id.igdb",
      incoming: "119133",
      stored: "999999",
    })]);
  });

  it("blocks when the mapped IGDB identity belongs to another canonical game", async () => {
    const normalized = normalization();
    const snapshot = matchingSnapshot(normalized);
    snapshot.externalIds = [];

    const identityConflict = await planIgdbEnrichment(
      fakeStore({ externalIds: [externalIdRow(77)] }),
      snapshot,
      normalized,
    );

    expect(identityConflict.action).toBe("blocked");
    expect(identityConflict.creates).toEqual([]);
    expect(identityConflict.updates).toEqual([]);
    expect(identityConflict.conflicts).toEqual([expect.objectContaining({
      code: "identity_conflict",
      field: "external_id.igdb:119133",
      incoming: 42,
      stored: 77,
    })]);
  });

  it.each([
    {
      name: "canonical game ID",
      mutate(normalized: IgdbNormalizationResult, snapshot: IgdbEnrichmentSnapshot) {
        normalized.candidate.identity.canonicalGameId = 77;
        return {
          field: "identity.canonicalGameId",
          incoming: 77,
          stored: snapshot.game.id,
        };
      },
    },
    {
      name: "Steam App ID",
      mutate(normalized: IgdbNormalizationResult, snapshot: IgdbEnrichmentSnapshot) {
        normalized.candidate.identity.steamAppId = "999999";
        return {
          field: "identity.steamAppId",
          incoming: "999999",
          stored: snapshot.steamAppId,
        };
      },
    },
  ])("blocks a mismatched candidate $name before any lookup", async ({ mutate }) => {
    const normalized = normalization();
    const snapshot = matchingSnapshot(normalized);
    const expected = mutate(normalized, snapshot);
    const store = fakeStore();
    store.findExternalIdsByProvider = async () => {
      throw new Error("identity mismatch reached a candidate lookup");
    };

    const plan = await planIgdbEnrichment(store, snapshot, normalized);

    expect(plan.action).toBe("blocked");
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toEqual([expect.objectContaining({
      code: "identity_conflict",
      ...expected,
    })]);
  });

  it("emits only persistence-ready additive operations and leaves unrelated rows intact", async () => {
    const normalized = normalization();
    normalized.candidate.genres = [
      { slug: "role-playing-rpg", name: "Role-playing (RPG)" },
      { slug: "action", name: "Action" },
    ];
    normalized.candidate.platforms = [{ slug: "windows", name: "Windows" }];
    normalized.candidate.companies = [
      { preferredSlug: "fromsoftware", name: "FromSoftware", websiteUrl: null, role: "developer" },
      { preferredSlug: "fromsoftware", name: "FromSoftware", websiteUrl: null, role: "publisher" },
    ];
    normalized.candidate.officialLinks = [{
      provider: "igdb",
      platform: null,
      linkType: "official_website",
      url: "https://www.bandainamcoent.com/games/elden-ring",
      isOfficial: true,
      verificationStatus: "unverified",
      verificationMethod: null,
    }];
    normalized.candidate.images = [
      {
        type: "cover",
        sourceUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co4jni.jpg",
        width: 264,
        height: 374,
        sortOrder: 0,
      },
      {
        type: "artwork",
        sourceUrl: "https://images.igdb.com/igdb/image/upload/t_1080p/ar1x9v.jpg",
        width: 1920,
        height: 1080,
        sortOrder: 1,
      },
    ];
    normalized.candidate.videos = [{
      provider: "igdb",
      externalId: "E3Huy2cdih0",
      title: "Launch Trailer",
      thumbnailUrl: null,
      sortOrder: 0,
    }];
    const snapshot = matchingSnapshot(normalized);
    snapshot.genres = [{ id: 90, slug: "legacy", name: "Legacy", createdAt: now, updatedAt: now }];
    snapshot.platforms = [{ id: 91, slug: "linux", name: "Linux", createdAt: now, updatedAt: now }];
    snapshot.companies = [{
      id: 92,
      slug: "legacy-company",
      name: "Legacy Company",
      websiteUrl: "https://legacy.example.test/",
      role: "support",
      createdAt: now,
      updatedAt: now,
    }];

    const plan = await planIgdbEnrichment(fakeStore({
      externalIds: [externalIdRow()],
      genres: [{
        id: 1,
        slug: "role-playing-rpg",
        name: "Role-playing (RPG)",
        createdAt: now,
        updatedAt: now,
      }],
    }), snapshot, normalized);

    expect(plan.action).toBe("enrich");
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([
      {
        entity: "game_genre",
        key: "42:role-playing-rpg",
        values: { gameId: 42, genreSlug: "role-playing-rpg" },
      },
      {
        entity: "genre",
        key: "action",
        values: { slug: "action", name: "Action" },
      },
      {
        entity: "game_genre",
        key: "42:action",
        values: { gameId: 42, genreSlug: "action" },
      },
      {
        entity: "platform",
        key: "windows",
        values: { slug: "windows", name: "Windows" },
      },
      {
        entity: "game_platform",
        key: "42:windows",
        values: { gameId: 42, platformSlug: "windows" },
      },
      {
        entity: "company",
        key: "fromsoftware",
        values: { slug: "fromsoftware", name: "FromSoftware", websiteUrl: null },
      },
      {
        entity: "game_company",
        key: "42:fromsoftware:developer",
        values: { gameId: 42, companySlug: "fromsoftware", role: "developer" },
      },
      {
        entity: "game_company",
        key: "42:fromsoftware:publisher",
        values: { gameId: 42, companySlug: "fromsoftware", role: "publisher" },
      },
      {
        entity: "official_link",
        key: "https://www.bandainamcoent.com/games/elden-ring",
        values: {
          gameId: 42,
          provider: "igdb",
          platform: null,
          linkType: "official_website",
          url: "https://www.bandainamcoent.com/games/elden-ring",
          isOfficial: true,
          verificationStatus: "unverified",
          verificationMethod: null,
        },
      },
      {
        entity: "image",
        key: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co4jni.jpg",
        values: {
          gameId: 42,
          type: "cover",
          sourceUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co4jni.jpg",
          width: 264,
          height: 374,
          sortOrder: 0,
        },
      },
      {
        entity: "image",
        key: "https://images.igdb.com/igdb/image/upload/t_1080p/ar1x9v.jpg",
        values: {
          gameId: 42,
          type: "artwork",
          sourceUrl: "https://images.igdb.com/igdb/image/upload/t_1080p/ar1x9v.jpg",
          width: 1920,
          height: 1080,
          sortOrder: 1,
        },
      },
      {
        entity: "video",
        key: "igdb:E3Huy2cdih0",
        values: {
          gameId: 42,
          provider: "igdb",
          externalId: "E3Huy2cdih0",
          title: "Launch Trailer",
          thumbnailUrl: null,
          sortOrder: 0,
        },
      },
    ]);
  });

  it("does not rename colliding taxonomies", async () => {
    const normalized = normalization();
    normalized.candidate.genres = [{ slug: "action", name: "Action" }];
    normalized.candidate.platforms = [{ slug: "windows", name: "Windows" }];

    const plan = await planIgdbEnrichment(fakeStore({
      externalIds: [externalIdRow()],
      genres: [{ id: 1, slug: "action", name: "Adventure", createdAt: now, updatedAt: now }],
      platforms: [{ id: 2, slug: "windows", name: "Windows Phone", createdAt: now, updatedAt: now }],
    }), matchingSnapshot(normalized), normalized);

    expect(plan.action).toBe("existing");
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.skips).toEqual([
      {
        field: "genre.action",
        reason: "taxonomy_conflict",
        incoming: "Action",
        stored: "Adventure",
      },
      {
        field: "platform.windows",
        reason: "taxonomy_conflict",
        incoming: "Windows",
        stored: "Windows Phone",
      },
    ]);
  });

  it("skips a taxonomy slug when candidate names contradict each other", async () => {
    const normalized = normalization();
    normalized.candidate.genres = [
      { slug: "action", name: "Action" },
      { slug: "action", name: "Action Adventure" },
    ];

    const plan = await planIgdbEnrichment(
      fakeStore({ externalIds: [externalIdRow()] }),
      matchingSnapshot(normalized),
      normalized,
    );

    expect(plan.action).toBe("existing");
    expect(plan.creates).toEqual([]);
    expect(plan.skips).toEqual([{
      field: "genre.action",
      reason: "taxonomy_conflict",
      incoming: ["Action", "Action Adventure"],
      stored: null,
    }]);
  });

  it("skips every taxonomy slug when candidate names collide", async () => {
    const normalized = normalization();
    normalized.candidate.genres = [
      { slug: "action", name: "Action" },
      { slug: "action-adventure", name: "Action" },
    ];
    normalized.candidate.platforms = [
      { slug: "windows", name: "Windows" },
      { slug: "windows-alternate", name: "Windows" },
    ];

    const plan = await planIgdbEnrichment(
      fakeStore({ externalIds: [externalIdRow()] }),
      matchingSnapshot(normalized),
      normalized,
    );

    expect(plan.action).toBe("existing");
    expect(plan.creates).toEqual([]);
    expect(plan.skips).toEqual([
      {
        field: "genre.action",
        reason: "taxonomy_conflict",
        incoming: { slug: "action", name: "Action" },
        stored: { slug: "action-adventure", name: "Action" },
      },
      {
        field: "genre.action-adventure",
        reason: "taxonomy_conflict",
        incoming: { slug: "action-adventure", name: "Action" },
        stored: { slug: "action", name: "Action" },
      },
      {
        field: "platform.windows",
        reason: "taxonomy_conflict",
        incoming: { slug: "windows", name: "Windows" },
        stored: { slug: "windows-alternate", name: "Windows" },
      },
      {
        field: "platform.windows-alternate",
        reason: "taxonomy_conflict",
        incoming: { slug: "windows-alternate", name: "Windows" },
        stored: { slug: "windows", name: "Windows" },
      },
    ]);
  });

  it("skips taxonomy names already owned by different indexed slugs", async () => {
    const normalized = normalization();
    normalized.candidate.genres = [{ slug: "action", name: "Shared Genre" }];
    normalized.candidate.platforms = [{ slug: "windows", name: "Shared Platform" }];

    const plan = await planIgdbEnrichment(fakeStore({
      externalIds: [externalIdRow()],
      genres: [{
        id: 1,
        slug: "adventure",
        name: "Shared Genre",
        createdAt: now,
        updatedAt: now,
      }],
      platforms: [{
        id: 2,
        slug: "linux",
        name: "Shared Platform",
        createdAt: now,
        updatedAt: now,
      }],
    }), matchingSnapshot(normalized), normalized);

    expect(plan.action).toBe("existing");
    expect(plan.creates).toEqual([]);
    expect(plan.skips).toEqual([
      {
        field: "genre.action",
        reason: "taxonomy_conflict",
        incoming: { slug: "action", name: "Shared Genre" },
        stored: { slug: "adventure", name: "Shared Genre" },
      },
      {
        field: "platform.windows",
        reason: "taxonomy_conflict",
        incoming: { slug: "windows", name: "Shared Platform" },
        stored: { slug: "linux", name: "Shared Platform" },
      },
    ]);
  });

  it("uses a deterministic new company slug instead of renaming a shared company", async () => {
    const normalized = normalization();
    normalized.candidate.companies = [{
      preferredSlug: "fromsoftware",
      name: "FromSoftware",
      websiteUrl: null,
      role: "developer",
    }];

    const plan = await planIgdbEnrichment(fakeStore({
      externalIds: [externalIdRow()],
      companies: [{
        id: 5,
        slug: "fromsoftware",
        name: "From Software Consulting",
        websiteUrl: "https://consulting.example.test/",
        createdAt: now,
        updatedAt: now,
      }],
    }), matchingSnapshot(normalized), normalized);

    expect(plan.action).toBe("enrich");
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([
      {
        entity: "company",
        key: "fromsoftware-66a8777a",
        values: { slug: "fromsoftware-66a8777a", name: "FromSoftware", websiteUrl: null },
      },
      {
        entity: "game_company",
        key: "42:fromsoftware-66a8777a:developer",
        values: { gameId: 42, companySlug: "fromsoftware-66a8777a", role: "developer" },
      },
    ]);
    expect(plan.warnings).toContainEqual(expect.objectContaining({
      code: "company_slug_collision",
      path: "companies.fromsoftware",
    }));
  });

  it("preserves existing company websites and official-link verification metadata", async () => {
    const normalized = normalization();
    normalized.candidate.companies = [{
      preferredSlug: "fromsoftware",
      name: "FromSoftware",
      websiteUrl: null,
      role: "developer",
    }];
    normalized.candidate.officialLinks = [{
      provider: "igdb",
      platform: null,
      linkType: "official_website",
      url: "https://www.fromsoftware.jp/",
      isOfficial: true,
      verificationStatus: "unverified",
      verificationMethod: null,
    }];
    const snapshot = matchingSnapshot(normalized);
    const company = {
      id: 5,
      slug: "fromsoftware",
      name: "FromSoftware",
      websiteUrl: "https://www.fromsoftware.jp/",
      createdAt: now,
      updatedAt: now,
    };
    snapshot.companies = [{ ...company, role: "developer" }];
    const link = {
      id: 6,
      gameId: 42,
      provider: "manual",
      platform: null,
      linkType: "official_website",
      url: "https://www.fromsoftware.jp/",
      region: null,
      isOfficial: true,
      verificationStatus: "verified",
      verificationMethod: "manual",
      httpStatus: 200,
      redirectUrl: null,
      verifiedAt: now,
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    snapshot.officialLinks = [link];

    const plan = await planIgdbEnrichment(fakeStore({
      externalIds: [externalIdRow()],
      companies: [company],
      officialLinks: [link],
    }), snapshot, normalized);

    expect(plan.action).toBe("existing");
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it("reports preserved existing link and media metadata without enriching", async () => {
    const normalized = normalization();
    normalized.candidate.officialLinks = [{
      provider: "igdb",
      platform: null,
      linkType: "official_website",
      url: "https://game.example.test/",
      isOfficial: true,
      verificationStatus: "unverified",
      verificationMethod: null,
    }];
    normalized.candidate.images = [{
      type: "artwork",
      sourceUrl: "https://images.example.test/shared.jpg",
      width: 1920,
      height: 1080,
      sortOrder: 0,
    }];
    normalized.candidate.videos = [{
      provider: "igdb",
      externalId: "shared-video",
      title: "Provider title",
      thumbnailUrl: null,
      sortOrder: 0,
    }];
    const snapshot = matchingSnapshot(normalized);
    const link = {
      id: 7,
      gameId: 42,
      provider: "manual",
      platform: null,
      linkType: "official_website",
      url: "https://game.example.test/",
      region: null,
      isOfficial: true,
      verificationStatus: "verified",
      verificationMethod: "manual",
      httpStatus: 200,
      redirectUrl: null,
      verifiedAt: now,
      lastCheckedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const image = {
      id: 8,
      gameId: 42,
      type: "screenshot",
      sourceUrl: "https://images.example.test/shared.jpg",
      storageUrl: null,
      width: 1280,
      height: 720,
      sortOrder: 9,
      createdAt: now,
    };
    const video = {
      id: 9,
      gameId: 42,
      provider: "igdb",
      externalId: "shared-video",
      title: "Curated title",
      thumbnailUrl: null,
      sortOrder: 9,
      createdAt: now,
    };
    snapshot.officialLinks = [link];
    snapshot.images = [image];
    snapshot.videos = [video];

    const plan = await planIgdbEnrichment(fakeStore({
      externalIds: [externalIdRow()],
      officialLinks: [link],
      images: [image],
      videos: [video],
    }), snapshot, normalized);

    expect(plan.action).toBe("existing");
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.skips).toEqual(expect.arrayContaining([
      {
        field: "official_link.https://game.example.test/.provider",
        reason: "existing_metadata_preserved",
        incoming: "igdb",
        stored: "manual",
      },
      {
        field: "official_link.https://game.example.test/.verificationStatus",
        reason: "existing_metadata_preserved",
        incoming: "unverified",
        stored: "verified",
      },
      {
        field: "image.https://images.example.test/shared.jpg.type",
        reason: "existing_metadata_preserved",
        incoming: "artwork",
        stored: "screenshot",
      },
      {
        field: "video.igdb:shared-video.title",
        reason: "existing_metadata_preserved",
        incoming: "Provider title",
        stored: "Curated title",
      },
      {
        field: "video.igdb:shared-video.sortOrder",
        reason: "existing_metadata_preserved",
        incoming: 0,
        stored: 9,
      },
    ]));
  });

  it("plans media only up to the normalized candidate bounds", async () => {
    const normalized = normalization();
    normalized.candidate.images = [
      {
        type: "cover",
        sourceUrl: "https://images.example.test/cover.jpg",
        width: null,
        height: null,
        sortOrder: 0,
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: "artwork" as const,
        sourceUrl: `https://images.example.test/artwork-${index}.jpg`,
        width: null,
        height: null,
        sortOrder: index + 1,
      })),
      ...Array.from({ length: 50 }, (_, index) => ({
        type: "screenshot" as const,
        sourceUrl: `https://images.example.test/screenshot-${index}.jpg`,
        width: null,
        height: null,
        sortOrder: index + 21,
      })),
    ];
    normalized.candidate.videos = Array.from({ length: 20 }, (_, index) => ({
      provider: "igdb" as const,
      externalId: `video-${index}`,
      title: null,
      thumbnailUrl: null,
      sortOrder: index,
    }));

    const plan = await planIgdbEnrichment(
      fakeStore({ externalIds: [externalIdRow()] }),
      matchingSnapshot(normalized),
      normalized,
    );

    expect(plan.action).toBe("enrich");
    expect(plan.creates.filter(({ entity }) => entity === "image")).toHaveLength(71);
    expect(plan.creates.filter(({ entity }) => entity === "video")).toHaveLength(20);
  });

  it("does not accept provider mapping errors as planner inputs", () => {
    type PlannerNormalization = Parameters<typeof planIgdbEnrichment>[2];
    const mappingError = new IgdbError("mapping_not_found", "No mapping", { retryable: false });

    // @ts-expect-error Mapping errors stop before the planner and cannot replace normalization.
    const invalidPlannerInput: PlannerNormalization = mappingError;

    expect(invalidPlannerInput).toBe(mappingError);
  });
});
