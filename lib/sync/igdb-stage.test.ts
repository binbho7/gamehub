import { expect, it, vi } from "vitest";
import { IgdbError, type IgdbErrorCode } from "../providers/igdb/errors";
import { createIgdbStage } from "./igdb-stage";
import { stageError } from "./stages";
import type { IgdbEnrichmentResult } from "../enrichers/igdb-candidate";

function result(status: IgdbEnrichmentResult["status"] = "enrich", dryRun = true): IgdbEnrichmentResult {
  return {
    status,
    gameId: 41,
    dryRun,
    affectedRows: 0,
    plan: {
      action: status,
      gameId: 41,
      slug: "game",
      matchedIgdbGame: null,
      creates: [],
      updates: [],
      skips: [],
      warnings: [],
      conflicts: [],
    },
  } as IgdbEnrichmentResult;
}

it("maps enrich and existing to success and blocked to failure", async () => {
  for (const action of ["enrich", "existing", "blocked"] as const) {
    const enrichGame = vi.fn().mockResolvedValue(result(action));
    const promise = createIgdbStage({ enrichGame }).execute(41, { dryRun: true });
    if (action === "blocked") await expect(promise).rejects.toEqual(stageError("igdb", "blocked"));
    else await expect(promise).resolves.toEqual({ summary: "IGDB " + action + "." });
    expect(enrichGame).toHaveBeenCalledExactlyOnceWith(41, { dryRun: true });
  }
});

it.each([
  "missing_credentials", "invalid_credentials", "authentication_failed", "timeout", "network_error",
  "rate_limited", "provider_unavailable", "http_error", "malformed_json", "schema_changed",
  "canonical_game_not_found", "steam_external_id_missing", "mapping_not_found", "mapping_ambiguous",
  "unsupported_mapping", "igdb_game_not_found", "write_conflict", "invalid_game_id",
] as IgdbErrorCode[])("maps IgdbError %s without payload or secret", async (code) => {
  const enrichGame = vi.fn().mockRejectedValue(new IgdbError(code, "secret", {
    retryable: false,
    cause: "secret",
  }));
  await expect(createIgdbStage({ enrichGame }).execute(41, { dryRun: true }))
    .rejects.toEqual(stageError("igdb", code));
});

it.each([
  ["gameId", result("enrich"), { gameId: 42 }],
  ["dryRun", result("enrich"), { dryRun: false }],
  ["plan gameId", result("enrich"), { plan: { ...result("enrich").plan, gameId: 42 } }],
  ["plan action", result("enrich"), { plan: { ...result("enrich").plan, action: "existing" } }],
] as const)("rejects IGDB %s result mismatch", async (_label, base, override) => {
  const enrichGame = vi.fn().mockResolvedValue({ ...base, ...override });
  await expect(createIgdbStage({ enrichGame }).execute(41, { dryRun: true }))
    .rejects.toEqual(stageError("igdb", "invalid_result"));
});

it("propagates write mode to the enricher", async () => {
  const enrichGame = vi.fn().mockResolvedValue(result("existing", false));
  await expect(createIgdbStage({ enrichGame }).execute(41, { dryRun: false }))
    .resolves.toEqual({ summary: "IGDB existing." });
  expect(enrichGame).toHaveBeenCalledExactlyOnceWith(41, { dryRun: false });
});

it("propagates native stage errors and maps unknown exceptions", async () => {
  const stageFailure = stageError("igdb", "write_conflict");
  await expect(createIgdbStage({ enrichGame: vi.fn().mockRejectedValue(stageFailure) })
    .execute(41, { dryRun: false })).rejects.toEqual(stageFailure);
  await expect(createIgdbStage({ enrichGame: vi.fn().mockRejectedValue(new Error("secret")) })
    .execute(41, { dryRun: true })).rejects.toEqual(stageError("igdb", "unexpected_error"));
});
