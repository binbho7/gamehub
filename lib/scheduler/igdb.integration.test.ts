import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildIgdbQueries } from "../db/repositories/igdb-enrichment-queries";
import { createIgdbEnrichmentStore } from "../db/repositories/igdb-enrichment";
import { createScheduledIgdbStore } from "../db/repositories/scheduled/igdb";
import { executeFencedBatch, fencePredicate } from "../db/repositories/scheduled/fence";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import { createIgdbEnricher } from "../enrichers/igdb";
import type { IgdbEnrichmentPlan } from "../enrichers/igdb-candidate";
import { planIgdbEnrichment } from "../enrichers/igdb-plan";
import { normalizeIgdbGame } from "../providers/igdb/normalize";
import { parseIgdbGame } from "../providers/igdb/response";
import { createCronSignals } from "./signals";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";

const fullIgdbPlan: IgdbEnrichmentPlan = {
  action: "enrich", gameId: 8, slug: "g8", matchedIgdbGame: { id: "800", name: "Game" },
  creates: [
    { entity: "external_id", key: "igdb:800", values: { gameId: 8, provider: "igdb", externalId: "800", externalUrl: null } },
    { entity: "genre", key: "action", values: { slug: "action", name: "Action" } },
    { entity: "game_genre", key: "8:action", values: { gameId: 8, genreSlug: "action" } },
    { entity: "platform", key: "pc", values: { slug: "pc", name: "PC" } },
    { entity: "game_platform", key: "8:pc", values: { gameId: 8, platformSlug: "pc" } },
    { entity: "company", key: "studio", values: { slug: "studio", name: "Studio", websiteUrl: null } },
    { entity: "game_company", key: "8:studio:developer", values: { gameId: 8, companySlug: "studio", role: "developer" } },
    { entity: "official_link", key: "https://example.com/", values: { gameId: 8, provider: "igdb", platform: null, linkType: "official_website", url: "https://example.com/", isOfficial: true, verificationStatus: "unverified", verificationMethod: null } },
    { entity: "image", key: "cover", values: { gameId: 8, type: "cover", sourceUrl: "https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg", width: 600, height: 800, sortOrder: 0 } },
    { entity: "video", key: "igdb:clip", values: { gameId: 8, provider: "igdb", externalId: "clip", title: "Trailer", thumbnailUrl: null, sortOrder: 0 } },
  ],
  updates: [{ entity: "game", key: "8", changes: {
    summary: "Summary", description: "Description", releaseDate: "2026-09-01",
    coverUrl: "https://example.com/cover.jpg", heroUrl: "https://example.com/hero.jpg",
  } }], skips: [], warnings: [], conflicts: [],
};

const gameBody = [{
  id: 800, name: "Game", summary: "Summary", storyline: "Description", first_release_date: 1788220800,
  genres: [{ id: 1, name: "Action", slug: "action" }],
  platforms: [{ id: 6, name: "PC", slug: "pc" }],
  involved_companies: [{ developer: true, publisher: true, company: { id: 1, name: "Studio", slug: "studio" } }],
  cover: { image_id: "abc", width: 600, height: 800 },
  artworks: [{ image_id: "art", width: 1200, height: 800 }],
  screenshots: [{ image_id: "shot", width: 1200, height: 800 }],
  videos: [{ video_id: "abcDEF12345", name: "Trailer" }],
  websites: [{ type: 1, trusted: true, url: "https://example.com/" }],
}];

describe("scheduled IGDB complete mutation fencing", () => {
  let f: SchedulerD1Fixture;
  beforeAll(async () => { f = await createSchedulerD1Fixture(); }, 30_000);
  afterAll(async () => { await f?.dispose(); });
  beforeEach(async () => {
    await f.binding.prepare("DELETE FROM games").run();
    for (const table of ["genres", "platforms", "companies", "cron_sync_lease"]) {
      await f.binding.prepare(`DELETE FROM ${table}`).run();
    }
    await f.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
    await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(8,'g8','Curated title')").run();
    await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(8,'steam','80')").run();
  });

  async function scheduled() {
    const acquired = await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000);
    if (acquired.status !== "acquired") throw new Error("fixture lease unavailable");
    const signals = createCronSignals();
    return { authority: acquired.lease, signals, store: createScheduledIgdbStore({
      binding: f.binding, db: f.db, candidate: { gameId: 8, appId: "80" }, authority: acquired.lease, signals,
    }) };
  }

  async function expire(replace = false) {
    await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
    if (replace) await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000);
  }

  it("rolls back taxonomy and media when the final fence assertion fails", async () => {
    const { authority } = await scheduled();
    const before = await f.dump();
    const rows = buildIgdbQueries(f.db, fullIgdbPlan, fencePredicate(authority));
    await expect(executeFencedBatch(f.binding, authority, [...rows, {
      sql: "UPDATE cron_sync_lease SET lease_expires_at=1 WHERE name='game-sync'", params: [], minChanges: 1, maxChanges: 1,
    }])).rejects.toMatchObject({ code: "fence_lost" });
    expect(await f.dump()).toEqual(before);
  });

  it("negative control demonstrates that an unfenced stale full plan mutates the inventory", async () => {
    await scheduled();
    await expire(true);
    expect(await createIgdbEnrichmentStore(f.db).applyPlan(fullIgdbPlan)).toEqual({ affectedRows: 11 });
    const dump = await f.dump();
    for (const table of ["genres", "platforms", "companies", "game_genres", "game_platforms", "game_companies", "game_images", "game_videos", "game_official_links"]) {
      expect(dump[table]).toHaveLength(1);
    }
  });

  it("commits every inventory mutation, counts only domain writes and preserves curated fields", async () => {
    const { store } = await scheduled();
    await f.binding.prepare("UPDATE games SET summary='Curated',cover_url='https://example.com/curated.jpg'").run();
    expect(await store.applyPlan(fullIgdbPlan)).toEqual({ affectedRows: 11 });
    const snapshot = await store.findSnapshotByGameId(8);
    expect(snapshot?.game).toMatchObject({ title: "Curated title", summary: "Curated", description: "Description", releaseDate: "2026-09-01", coverUrl: "https://example.com/curated.jpg", heroUrl: "https://example.com/hero.jpg" });
    expect(snapshot?.externalIds.map((row) => row.provider)).toEqual(["steam", "igdb"]);
    expect(snapshot?.genres[0].name).toBe("Action");
    expect(snapshot?.platforms[0].name).toBe("PC");
    expect(snapshot?.companies[0]).toMatchObject({ name: "Studio", websiteUrl: null, role: "developer" });
    expect(snapshot?.officialLinks[0]).toMatchObject({ provider: "igdb", isOfficial: true, verificationStatus: "unverified", verificationMethod: null, region: null });
    expect(snapshot?.images[0]).toMatchObject({ sourceProvider: "igdb", storageKey: null, width: 600, height: 800 });
    expect(snapshot?.videos[0]).toMatchObject({ provider: "igdb", externalId: "clip", sortOrder: 0 });
    expect(await store.applyPlan({ ...fullIgdbPlan, creates: fullIgdbPlan.creates.filter((row) => row.entity === "image") })).toEqual({ affectedRows: 0 });
  });

  it.each([false, true])("prevents every mutation after expiry (replacement owner: %s)", async (replace) => {
    const { store, authority, signals } = await scheduled();
    await expire(replace);
    const before = await f.dump();
    // Execute the compiled mutations alone: every write must carry its own guard.
    const rows = buildIgdbQueries(f.db, fullIgdbPlan, fencePredicate(authority));
    const results = await f.binding.batch(rows.map((row) => f.binding.prepare(row.sql).bind(...row.params)));
    expect(results.map((row) => row.meta.changes)).toEqual(Array(12).fill(0));
    await expect(store.applyPlan(fullIgdbPlan)).rejects.toMatchObject({ code: "write_conflict", retryable: false });
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
    expect(await f.dump()).toEqual(before);
  });

  it("guards the duplicate identity assertion and preserves real identity conflict decoding", async () => {
    const { store, authority, signals } = await scheduled();
    await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(8,'igdb','801')").run();
    const before = await f.dump();
    await expect(store.applyPlan(fullIgdbPlan)).rejects.toMatchObject({ code: "write_conflict", constraint: "igdb_external_identity_unique", retryable: false });
    expect(await f.dump()).toEqual(before);
    expect(signals.readAuthorityLoss()).toBeNull();
    await expire();
    const rows = buildIgdbQueries(f.db, fullIgdbPlan, fencePredicate(authority));
    expect((await f.binding.batch(rows.map((row) => f.binding.prepare(row.sql).bind(...row.params)))).every((row) => row.meta.changes === 0)).toBe(true);
  });

  it("rolls back an identity and game update when a later taxonomy insert conflicts", async () => {
    const { store, signals } = await scheduled();
    await f.binding.prepare("INSERT INTO genres(slug,name) VALUES('action','Existing')").run();
    const before = await f.dump();
    await expect(store.applyPlan(fullIgdbPlan)).rejects.toMatchObject({ code: "write_conflict", constraint: undefined });
    expect(await f.dump()).toEqual(before);
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it("validates existing plan authority without counting fence assertions", async () => {
    const { store, signals } = await scheduled();
    const existing = { ...fullIgdbPlan, action: "existing" as const, creates: [], updates: [] };
    expect(await store.applyPlan(existing)).toEqual({ affectedRows: 0 });
    await expire();
    await expect(store.applyPlan(existing)).rejects.toMatchObject({ code: "write_conflict" });
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
  });

  it("rejects cross-candidate plans and removed Steam mapping without auxiliary writes", async () => {
    const { store, signals } = await scheduled();
    for (const plan of [
      { ...fullIgdbPlan, gameId: 9 },
      { ...fullIgdbPlan, creates: [{ entity: "image" as const, key: "other", values: { gameId: 9, type: "cover" as const, sourceUrl: "https://example.com/other.jpg", width: null, height: null, sortOrder: 0 } }] },
    ]) {
      await expect(store.applyPlan(plan)).rejects.toMatchObject({ code: "write_conflict" });
    }
    await f.binding.prepare("DELETE FROM game_external_ids").run();
    const before = await f.dump();
    await expect(store.applyPlan(fullIgdbPlan)).rejects.toMatchObject({ code: "write_conflict" });
    expect(await f.dump()).toEqual(before);
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it("rejects a late provider result after B acquires using a real full normalization and plan", async () => {
    const { store, signals } = await scheduled();
    const snapshot = await store.findSnapshotByGameId(8);
    const normalization = normalizeIgdbGame(parseIgdbGame(gameBody, 800), { canonicalGameId: 8, steamAppId: "80", igdbGameId: 800 }, new Date(0));
    const plan = await planIgdbEnrichment(store, snapshot!, normalization);
    expect(new Set(plan.creates.map((row) => row.entity))).toEqual(new Set(fullIgdbPlan.creates.map((row) => row.entity)));
    expect(plan.updates.length).toBeGreaterThan(0);
    let resume!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const enricher = createIgdbEnricher({ store, client: { async request(endpoint, query) {
      if (endpoint === "games") { reached(); await held; }
      return { fetchedAt: new Date(0), body: endpoint === "games" ? gameBody : query.includes("game !=") ? [] : [{ id: 1, game: 800, uid: "80", external_game_source: 1 }] };
    } } });
    const pending = enricher.enrichGame(8, { dryRun: false });
    await paused;
    await expire(true);
    const before = await f.dump();
    resume();
    await expect(pending).rejects.toMatchObject({ code: "write_conflict", constraint: undefined });
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
    expect(await f.dump()).toEqual(before);
  });

  it.each(["same", "other"])("preserves recovery when a concurrent writer claims the %s canonical identity", async (winner) => {
    const { store, signals } = await scheduled();
    let raced = false;
    const enricher = createIgdbEnricher({
      store,
      client: { async request(endpoint, query) {
        return { fetchedAt: new Date(0), body: endpoint === "games" ? gameBody : query.includes("game !=") ? [] : [{ id: 1, game: 800, uid: "80", external_game_source: 1 }] };
      } },
      async planEnrichment(plannerStore, snapshot, normalization) {
        const plan = await planIgdbEnrichment(plannerStore, snapshot, normalization);
        if (!raced) {
          raced = true;
          if (winner === "same") await createIgdbEnrichmentStore(f.db).applyPlan(plan);
          else {
            await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(9,'g9','Other')").run();
            await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(9,'igdb','800')").run();
          }
        }
        return plan;
      },
    });
    expect(await enricher.enrichGame(8, { dryRun: false })).toMatchObject({ status: winner === "same" ? "existing" : "blocked", affectedRows: 0 });
    expect(signals.readAuthorityLoss()).toBeNull();
    const snapshot = await store.findSnapshotByGameId(8);
    expect(snapshot?.companies.map((row) => ({ websiteUrl: row.websiteUrl, role: row.role }))).toEqual(winner === "same" ? [{ websiteUrl: null, role: "developer" }, { websiteUrl: null, role: "publisher" }] : []);
    expect(snapshot?.images).toHaveLength(winner === "same" ? 3 : 0);
    expect(snapshot?.game.summary).toBe(winner === "same" ? "Summary" : null);
  });
});
