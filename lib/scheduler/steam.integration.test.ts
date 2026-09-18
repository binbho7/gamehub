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
