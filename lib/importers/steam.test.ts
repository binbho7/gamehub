import { describe, expect, it, vi } from "vitest";
import validFixture from "../../test/fixtures/steam/appdetails-valid.json";
import type { SteamImportStore } from "../db/repositories/steam-import";
import type { SteamClient } from "../providers/steam/client";
import { createSteamImporter } from "./steam";

describe("createSteamImporter", () => {
  function dependencies() {
    const applyPlan = vi.fn<SteamImportStore["applyPlan"]>();
    const store: SteamImportStore = {
      findSnapshotByExternalId: vi.fn().mockResolvedValue(null),
      findGameBySlug: vi.fn().mockResolvedValue(null),
      findGenresBySlugs: vi.fn().mockResolvedValue([]),
      findPlatformsBySlugs: vi.fn().mockResolvedValue([]),
      findCompaniesBySlugs: vi.fn().mockResolvedValue([]),
      applyPlan,
    };
    const client: SteamClient = {
      fetchAppDetails: vi.fn().mockResolvedValue({
        body: validFixture,
        fetchedAt: new Date("2026-09-02T01:02:03.000Z"),
        requestUrl: "https://store.steampowered.com/api/appdetails?appids=1245620",
      }),
    };

    return { applyPlan, store, client };
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

    expect(result).toMatchObject({ status: "created", gameId: null, dryRun: false });
    expect(applyPlan).toHaveBeenCalledOnce();
    expect(applyPlan).toHaveBeenCalledWith(result.plan);
  });
});
