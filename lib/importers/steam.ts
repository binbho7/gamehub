import type { SteamImportStore } from "../db/repositories/steam-import";
import { normalizeSteamAppId } from "../providers/steam/app-id";
import type { SteamClient } from "../providers/steam/client";
import { normalizeSteamGame } from "../providers/steam/normalize";
import { parseSteamAppDetails } from "../providers/steam/response";
import type { SteamImportResult } from "./candidate";
import { SteamImportError } from "./errors";
import { planSteamImport } from "./steam-plan";

const MAX_CREATE_CONFLICT_RETRIES = 3;

function isSqliteUniqueConstraintError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current = error;

  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const record = current as { cause?: unknown; code?: unknown; message?: unknown };
    if (
      (typeof record.message === "string" && /\bUNIQUE constraint failed\b/i.test(record.message))
      || (typeof record.code === "string" && /^SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY)$/.test(record.code))
    ) {
      return true;
    }
    current = record.cause;
  }

  return false;
}

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
      let plan = await planSteamImport(store, normalized);

      if (options.dryRun ?? true) {
        const status = plan.action === "create"
          ? "created"
          : plan.action === "update"
            ? "updated"
            : "existing";
        return { status, gameId: plan.existingGameId, appId, dryRun: true, plan };
      }

      let remainingCreateConflictRetries = MAX_CREATE_CONFLICT_RETRIES;
      while (true) {
        try {
          await store.applyPlan(plan);
          break;
        } catch (cause) {
          if (
            plan.action !== "create"
            || remainingCreateConflictRetries === 0
            || !isSqliteUniqueConstraintError(cause)
          ) {
            throw cause;
          }
          remainingCreateConflictRetries -= 1;
          plan = await planSteamImport(store, normalized);
        }
      }

      const persisted = await store.findSnapshotByExternalId(
        plan.candidate.source.provider,
        plan.candidate.source.externalId,
      );
      if (!persisted) {
        throw new SteamImportError(
          "write_incomplete",
          `Steam import completed without a persisted mapping for App ID ${appId}`,
        );
      }
      const status = plan.action === "create"
        ? "created"
        : plan.action === "update"
          ? "updated"
          : "existing";
      return { status, gameId: persisted.game.id, appId, dryRun: false, plan };
    },
  };
}
