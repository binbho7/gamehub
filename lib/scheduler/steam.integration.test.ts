import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import validFixture from "../../test/fixtures/steam/appdetails-valid.json";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import { createScheduledSteamStore } from "../db/repositories/scheduled/steam";
import { buildSteamUpdateQueries } from "../db/repositories/steam-import-queries";
import { fencePredicate } from "../db/repositories/scheduled/fence";
import { SteamImportError } from "../importers/errors";
import { createSteamImporter } from "../importers/steam";
import type { SteamImportPlan } from "../importers/candidate";
import { createCronSignals } from "./signals";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";
import type { SteamHttpResponse } from "../providers/steam/client";

const DURATION = 1_500_000;
const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

function fixtureBody(appId: string) {
  const source = validFixture as Record<string, { success: boolean; data: { steam_appid: number } }>;
  const entry = structuredClone(Object.values(source)[0]);
  entry.data.steam_appid = Number(appId);
  return { [appId]: entry };
}

function refreshPlan(): SteamImportPlan {
  const storeUrl = "https://store.steampowered.com/app/70/";
  return {
    action: "update", existingGameId: 7, selectedSlug: "g7", resolvedCompanies: [],
    creates: [], skips: [], warnings: [],
    updates: [
      { entity: "external_id", key: "steam:70", changes: { externalUrl: storeUrl } },
      { entity: "official_link", key: storeUrl, changes: {
        isOfficial: true, verificationStatus: "verified", verificationMethod: "provider_api",
      } },
      { entity: "video", key: "steam:700", changes: { title: "New trailer", thumbnailUrl: "https://cdn.example.com/new.jpg" } },
    ],
    candidate: {
      source: { provider: "steam", externalId: "70", fetchedAt: new Date(0) },
      game: { preferredSlug: "g7", title: "Incoming title", summary: "Incoming summary", description: null,
        status: "released", releaseDate: null, coverUrl: null, heroUrl: null },
      externalIds: [{ provider: "steam", externalId: "70", externalUrl: storeUrl }],
      officialLinks: [{ provider: "steam", platform: null, linkType: "store", url: storeUrl,
        isOfficial: true, verificationStatus: "verified", verificationMethod: "provider_api" }],
      videos: [{ provider: "steam", externalId: "700", title: "New trailer",
        thumbnailUrl: "https://cdn.example.com/new.jpg", sortOrder: 0 }],
      genres: [], platforms: [], companies: [], images: [],
    },
  };
}

describe("scheduled Steam store", () => {
  let fixture: SchedulerD1Fixture;
  beforeAll(async () => { fixture = await createSchedulerD1Fixture(); }, 30_000);
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => {
    await fixture.binding.prepare("DELETE FROM game_videos").run();
    await fixture.binding.prepare("DELETE FROM game_official_links").run();
    await fixture.binding.prepare("DELETE FROM game_external_ids").run();
    await fixture.binding.prepare("DELETE FROM games").run();
    await fixture.binding.prepare("DELETE FROM cron_sync_lease").run();
    await fixture.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
    await fixture.binding.prepare("INSERT INTO games(id,slug,title) VALUES(7,'g7','Game')").run();
    await fixture.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id,external_url) VALUES(7,'steam','70',NULL)").run();
  });

  async function scheduledStore() {
    const acquired = await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
    if (acquired.status !== "acquired") throw new Error("fixture lease unavailable");
    const signals = createCronSignals();
    return { signals, store: createScheduledSteamStore({
      binding: fixture.binding, db: fixture.db, candidate: { gameId: 7, appId: "70" },
      authority: acquired.lease, signals,
    }) };
  }

  async function seedRefreshTargets() {
    await fixture.binding.prepare(`INSERT INTO game_official_links
      (game_id,provider,link_type,url,is_official,verification_status,verification_method)
      VALUES(7,'steam','store','https://store.steampowered.com/app/70/',0,'unverified',NULL)`).run();
    await fixture.binding.prepare(`INSERT INTO game_videos
      (game_id,provider,external_id,title,thumbnail_url,sort_order)
      VALUES(7,'steam','700','Old trailer','https://cdn.example.com/old.jpg',5)`).run();
  }

  it("refreshes S1 external ID, S2 official link and S3 video on real D1 without changing curated game fields", async () => {
    await seedRefreshTargets();
    const { store } = await scheduledStore();
    expect(await store.applyPlan(refreshPlan())).toEqual({ affectedRows: 3 });
    expect(await fixture.binding.prepare("SELECT external_url FROM game_external_ids WHERE game_id=7")
      .first<string>("external_url")).toBe("https://store.steampowered.com/app/70/");
    expect(await fixture.binding.prepare("SELECT is_official,verification_status,verification_method FROM game_official_links WHERE game_id=7").first())
      .toEqual({ is_official: 1, verification_status: "verified", verification_method: "provider_api" });
    expect(await fixture.binding.prepare("SELECT title,thumbnail_url,sort_order FROM game_videos WHERE game_id=7").first())
      .toEqual({ title: "New trailer", thumbnail_url: "https://cdn.example.com/new.jpg", sort_order: 5 });
    expect(await fixture.binding.prepare("SELECT title,summary FROM games WHERE id=7").first())
      .toEqual({ title: "Game", summary: null });
    expect(await store.applyPlan(refreshPlan())).toEqual({ affectedRows: 0 });
  });

  it("preserves a manual official link decision made after planning", async () => {
    await seedRefreshTargets();
    const { store } = await scheduledStore();
    const plan = refreshPlan();
    await fixture.binding.prepare("UPDATE game_official_links SET verification_method='manual',verification_status='failed'").run();
    const before = await fixture.binding.prepare("SELECT * FROM game_official_links").all();
    expect(await store.applyPlan(plan)).toEqual({ affectedRows: 2 });
    expect((await fixture.binding.prepare("SELECT * FROM game_official_links").all()).results).toEqual(before.results);
  });

  it("does not create absent links or videos from update plans", async () => {
    const { store } = await scheduledStore();
    expect(await store.applyPlan(refreshPlan())).toEqual({ affectedRows: 1 });
    expect(await fixture.binding.prepare("SELECT COUNT(*) AS n FROM game_official_links").first<number>("n")).toBe(0);
    expect(await fixture.binding.prepare("SELECT COUNT(*) AS n FROM game_videos").first<number>("n")).toBe(0);
    expect(await fixture.binding.prepare("SELECT COUNT(*) AS n FROM games").first<number>("n")).toBe(1);
  });

  it.each([
    ["removed", "DELETE FROM game_external_ids WHERE game_id=7"],
    ["changed", "UPDATE game_external_ids SET external_id='71' WHERE game_id=7"],
    ["ambiguous", "INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(7,'steam','71')"],
  ])("rejects a %s selected mapping during snapshot lookup", async (_label, race) => {
    const { store, signals } = await scheduledStore();
    await fixture.binding.prepare(race).run();
    const before = await fixture.dump();
    await expect(store.findSnapshotByExternalId("steam", "70")).rejects.toMatchObject({ code: "write_conflict" });
    expect(await fixture.dump()).toEqual(before);
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it.each([
    ["removed", "DELETE FROM game_external_ids WHERE game_id=7"],
    ["changed", "UPDATE game_external_ids SET external_id='71' WHERE game_id=7"],
    ["ambiguous", "INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(7,'steam','71')"],
  ])("rejects a %s selected mapping after snapshot and before apply", async (_label, race) => {
    await seedRefreshTargets();
    const { store, signals } = await scheduledStore();
    expect((await store.findSnapshotByExternalId("steam", "70"))?.game.id).toBe(7);
    await fixture.binding.prepare(race).run();
    const before = await fixture.dump();
    await expect(store.applyPlan(refreshPlan())).rejects.toMatchObject({ code: "write_conflict" });
    expect(await fixture.dump()).toEqual(before);
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it("prevents all S1/S2/S3 updates after ownership changes", async () => {
    await seedRefreshTargets();
    const { store, signals } = await scheduledStore();
    await fixture.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
    await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
    const before = await fixture.dump();
    await expect(store.applyPlan(refreshPlan())).rejects.toMatchObject({ code: "write_conflict" });
    expect(await fixture.dump()).toEqual(before);
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
  });

  it("rejects Steam apply after ownership changes", async () => {
    const acquired = await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
    if (acquired.status !== "acquired") throw new Error("fixture lease unavailable");
    const signals = createCronSignals();
    const store = createScheduledSteamStore({
      binding: fixture.binding,
      db: fixture.db,
      candidate: { gameId: 7, appId: "70" },
      authority: acquired.lease,
      signals,
    });
    const snapshot = await store.findSnapshotByExternalId("steam", "70");
    expect(snapshot?.game.id).toBe(7);
    await fixture.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
    await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
    const plan: SteamImportPlan = {
      action: "existing",
      existingGameId: 7,
      selectedSlug: "g7",
      resolvedCompanies: [],
      creates: [],
      updates: [],
      skips: [],
      warnings: [],
      candidate: {
        source: { provider: "steam", externalId: "70", fetchedAt: new Date(0) },
        game: {
          preferredSlug: "g7",
          title: "Game",
          summary: null,
          description: null,
          status: "released",
          releaseDate: null,
          coverUrl: null,
          heroUrl: null,
        },
        externalIds: [{ provider: "steam", externalId: "70", externalUrl: "https://store.steampowered.com/app/70/" }],
        officialLinks: [{
          provider: "steam",
          platform: null,
          linkType: "store",
          url: "https://store.steampowered.com/app/70/",
          isOfficial: true,
          verificationStatus: "verified",
          verificationMethod: "provider_api",
        }],
        genres: [],
        platforms: [],
        companies: [],
        images: [],
        videos: [],
      },
    };
    await expect(store.applyPlan(plan)).rejects.toMatchObject({ code: "write_conflict" });
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
  });

  it("rejects a paused Steam fetch after B acquires before apply", async () => {
    let resume!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const acquired = await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
    if (acquired.status !== "acquired") throw new Error("fixture lease unavailable");
    const signals = createCronSignals();
    const store = createScheduledSteamStore({
      binding: fixture.binding,
      db: fixture.db,
      candidate: { gameId: 7, appId: "70" },
      authority: acquired.lease,
      signals,
    });
    const importer = createSteamImporter({
      client: {
        async fetchAppDetails(appId): Promise<SteamHttpResponse> {
          await held;
          return {
            body: fixtureBody(appId),
            fetchedAt: new Date("2026-09-02T00:00:00.000Z"),
            requestUrl: `https://store.steampowered.com/api/appdetails?appids=${appId}`,
          };
        },
      },
      store,
    });
    const pending = importer.importGame("70", { dryRun: false });
    await fixture.binding.prepare(`UPDATE cron_sync_lease SET lease_expires_at=${DB_NOW}`).run();
    await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
    resume();
    await expect(pending).rejects.toBeInstanceOf(SteamImportError);
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
    expect(await fixture.binding.prepare("SELECT external_url FROM game_external_ids WHERE game_id=7")
      .first<string | null>("external_url")).toBeNull();
  });

  it("forbids scheduled create and compiles a fence onto every update", async () => {
    const acquired = await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
    if (acquired.status !== "acquired") throw new Error("fixture lease unavailable");
    const store = createScheduledSteamStore({
      binding: fixture.binding,
      db: fixture.db,
      candidate: { gameId: 7, appId: "70" },
      authority: acquired.lease,
      signals: createCronSignals(),
    });
    const candidate = {
      source: { provider: "steam" as const, externalId: "999", fetchedAt: new Date(0) },
      game: {
        preferredSlug: "missing",
        title: "Missing",
        summary: null,
        description: null,
        status: "released" as const,
        releaseDate: null,
        coverUrl: null,
        heroUrl: null,
      },
      externalIds: [{ provider: "steam" as const, externalId: "999", externalUrl: "https://store.steampowered.com/app/999/" }],
      officialLinks: [{
        provider: "steam" as const,
        platform: null,
        linkType: "store" as const,
        url: "https://store.steampowered.com/app/999/",
        isOfficial: true,
        verificationStatus: "verified" as const,
        verificationMethod: "provider_api" as const,
      }],
      genres: [],
      platforms: [],
      companies: [],
      images: [],
      videos: [],
    };
    const createPlan: SteamImportPlan = {
      action: "create",
      existingGameId: null,
      selectedSlug: "missing",
      resolvedCompanies: [],
      creates: [{ entity: "game", key: "missing" }],
      updates: [],
      skips: [],
      warnings: [],
      candidate,
    };
    await expect(store.applyPlan(createPlan)).rejects.toMatchObject({ code: "write_conflict" });
    expect(await fixture.binding.prepare("SELECT COUNT(*) AS n FROM games").first<number>("n")).toBe(1);

    const updatePlan: SteamImportPlan = {
      action: "update",
      existingGameId: 7,
      selectedSlug: "g7",
      resolvedCompanies: [],
      creates: [],
      skips: [],
      warnings: [],
      updates: [
        { entity: "external_id", key: "steam:70", changes: { externalUrl: "https://store.steampowered.com/app/70/" } },
      ],
      candidate: {
        ...candidate,
        source: { provider: "steam", externalId: "70", fetchedAt: new Date(0) },
        externalIds: [{ provider: "steam", externalId: "70", externalUrl: "https://store.steampowered.com/app/70/" }],
        officialLinks: [{
          ...candidate.officialLinks[0],
          url: "https://store.steampowered.com/app/70/",
        }],
      },
    };
    const compiled = buildSteamUpdateQueries(fixture.db, updatePlan, fencePredicate(acquired.lease));
    expect(compiled.length).toBeGreaterThan(0);
    for (const query of compiled) {
      expect(query.sql.toLowerCase()).toMatch(/exists[\s\S]*cron_sync_lease/);
    }
  });
});
