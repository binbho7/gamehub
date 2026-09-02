import type { SteamImportStore } from "../db/repositories/steam-import";
import { normalizeSteamAppId } from "../providers/steam/app-id";
import type { SteamClient } from "../providers/steam/client";
import { normalizeSteamGame } from "../providers/steam/normalize";
import { parseSteamAppDetails } from "../providers/steam/response";
import type { SteamImportResult } from "./candidate";
import { planSteamImport } from "./steam-plan";

export function createSteamImporter({
  client,
  store,
}: {
  client: SteamClient;
  store: SteamImportStore;
}) {
  return {
    async importGame(
      input: string | number,
      options: { dryRun?: boolean } = {},
    ): Promise<SteamImportResult> {
      const appId = normalizeSteamAppId(input);
      const http = await client.fetchAppDetails(appId);
      const raw = parseSteamAppDetails(http.body, appId);
      const normalized = normalizeSteamGame(raw, appId, http.fetchedAt);
      const plan = await planSteamImport(store, normalized);
      const status = plan.action === "create"
        ? "created"
        : plan.action === "update"
          ? "updated"
          : "existing";

      if (options.dryRun ?? true) {
        return { status, gameId: plan.existingGameId, appId, dryRun: true, plan };
      }
      await store.applyPlan(plan);
      return { status, gameId: plan.existingGameId, appId, dryRun: false, plan };
    },
  };
}
