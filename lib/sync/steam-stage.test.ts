import { expect, it, vi } from "vitest";
import validFixture from "../../test/fixtures/steam/appdetails-valid.json";
import { normalizeSteamGame } from "../providers/steam/normalize";
import { parseSteamAppDetails } from "../providers/steam/response";
import { SteamProviderError } from "../providers/steam/errors";
import { SteamImportError } from "../importers/errors";
import { createSteamStage } from "./steam-stage";
import { stageError } from "./stages";
import type { SteamImportResult } from "../importers/candidate";

function result(overrides: Partial<SteamImportResult> = {}): SteamImportResult {
  const normalized = normalizeSteamGame(
    parseSteamAppDetails(validFixture, "1245620"),
    "1245620",
    new Date("2026-09-02T01:02:03.000Z"),
  );
  return {
    status: "existing",
    gameId: 41,
    appId: "1245620",
    dryRun: true,
    plan: {
      action: "existing",
      existingGameId: 41,
      selectedSlug: "elden-ring",
      candidate: normalized.candidate,
      resolvedCompanies: [], creates: [], updates: [], skips: [], warnings: [],
    },
    ...overrides,
  };
}

it("passes scalar App ID and mode and discards Steam exception detail", async () => {
  const importGame = vi.fn().mockRejectedValue(new SteamProviderError("network_error", "token=secret", {
    retryable: true, cause: new Error("Authorization: secret"),
  }));
  await expect(createSteamStage({ importGame }).execute("10", { dryRun: true }))
    .rejects.toEqual(stageError("steam", "network_error"));
  expect(importGame).toHaveBeenCalledExactlyOnceWith("10", { dryRun: true });
});

it("returns the canonical identity and action for a valid result", async () => {
  const importGame = vi.fn().mockResolvedValue(result());
  await expect(createSteamStage({ importGame }).execute("1245620", { dryRun: true }))
    .resolves.toEqual({ gameId: 41, action: "existing", summary: "Steam existing." });
});

it("accepts a dry-run create without a persisted game ID", async () => {
  const importGame = vi.fn().mockResolvedValue(result({
    status: "created", gameId: null, plan: { ...result().plan, action: "create", existingGameId: null },
  }));
  await expect(createSteamStage({ importGame }).execute("1245620", { dryRun: true }))
    .resolves.toMatchObject({ gameId: null, action: "create" });
});

it("rejects a result whose identity or mode does not match the request", async () => {
  const importGame = vi.fn().mockResolvedValue(result({ appId: "999", dryRun: false }));
  await expect(createSteamStage({ importGame }).execute("1245620", { dryRun: true }))
    .rejects.toEqual(stageError("steam", "invalid_result"));
});

it.each([
  ["created", "create", true, 41],
  ["updated", "update", true, 41],
  ["existing", "update", false, 41],
  ["existing", "existing", true, 41],
] as const)("preserves native status/action and canonical identity (%s, %s)", async (status, action, dryRun, gameId) => {
  const importGame = vi.fn().mockResolvedValue(result({
    status, gameId, dryRun,
    plan: { ...result().plan, action },
  }));
  await expect(createSteamStage({ importGame }).execute("1245620", { dryRun }))
    .resolves.toEqual({ gameId, action, summary: `Steam ${status}.` });
});

it.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  "rejects unsafe canonical game ID %s",
  async (gameId) => {
    const importGame = vi.fn().mockResolvedValue(result({ gameId }));
    await expect(createSteamStage({ importGame }).execute("1245620", { dryRun: true }))
      .rejects.toEqual(stageError("steam", "invalid_result"));
  },
);

it("rejects a missing game ID for a write result", async () => {
  const importGame = vi.fn().mockResolvedValue(result({ dryRun: false, gameId: null }));
  await expect(createSteamStage({ importGame }).execute("1245620", { dryRun: false }))
    .rejects.toEqual(stageError("steam", "invalid_result"));
});

it.each([
  "timeout", "network_error", "rate_limited", "provider_unavailable", "http_error",
  "malformed_json", "schema_changed", "app_not_found", "app_id_mismatch",
  "unsupported_app_type", "invalid_app_id",
] as const)("maps SteamProviderError %s without leaking details", async (code) => {
  const importGame = vi.fn().mockRejectedValue(new SteamProviderError(code, "secret token", {
    retryable: true, cause: new Error("Authorization: secret"),
  }));
  await expect(createSteamStage({ importGame }).execute("1245620", { dryRun: true }))
    .rejects.toEqual(stageError("steam", code));
});

it.each([
  "taxonomy_conflict", "company_conflict", "write_conflict", "write_incomplete",
] as const)("maps SteamImportError %s without leaking details", async (code) => {
  const importGame = vi.fn().mockRejectedValue(new SteamImportError(code, "secret token"));
  await expect(createSteamStage({ importGame }).execute("1245620", { dryRun: false }))
    .rejects.toEqual(stageError("steam", code));
});

it("maps an unknown exception to unexpected_error", async () => {
  const importGame = vi.fn().mockRejectedValue(new Error("secret token"));
  await expect(createSteamStage({ importGame }).execute("1245620", { dryRun: true }))
    .rejects.toEqual(stageError("steam", "unexpected_error"));
});
