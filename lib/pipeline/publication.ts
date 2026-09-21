import { evaluateGames, type EligibilityDiagnostic } from "../site-data/eligibility";
import type { PublishedGame } from "../site-data/contracts";
import type { SiteSnapshotGame } from "../site-data/read-model";
import { parseItemStages } from "./state";
import { parseInputManifest, parsePublicationSelection, type PublicationSelection } from "./contracts";
import type { RunSnapshot } from "./run-repository";

export type PublicationDiagnostic = { steamAppId: string; code: string; message: string };
export type PublicationCandidate = { steamAppId: string; game: SiteSnapshotGame };
export type PublicationGateResult = {
  admitted: boolean;
  artifactGames: PublishedGame[];
  excluded: Array<{ steamAppId: string; game: SiteSnapshotGame | null }>;
  diagnostics: PublicationDiagnostic[];
};

export type PublicationGateInput = {
  snapshot: RunSnapshot;
  selection: unknown | PublicationSelection;
  candidates: readonly SiteSnapshotGame[];
};

function diagnostic(steamAppId: string, code: string, message: string): PublicationDiagnostic {
  return { steamAppId, code, message };
}

function bySteamId(candidates: readonly SiteSnapshotGame[]): Map<string, SiteSnapshotGame[]> {
  const result = new Map<string, SiteSnapshotGame[]>();
  for (const candidate of candidates) {
    for (const identity of candidate.externalIds.filter((value) => value.provider === "steam")) {
      const values = result.get(identity.externalId) ?? [];
      values.push(candidate);
      result.set(identity.externalId, values);
    }
  }
  return result;
}

function sortDiagnostics(values: PublicationDiagnostic[]): PublicationDiagnostic[] {
  return values.sort((left, right) => left.steamAppId.localeCompare(right.steamAppId, "en", { numeric: true })
    || left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
}

export function evaluatePublicationSelection(input: PublicationGateInput): PublicationGateResult {
  const manifest = parseInputManifest({
    manifestVersion: "1", pipelineVersion: input.snapshot.run.pipeline_version,
    policyVersion: input.snapshot.run.policy_version, snapshotDate: input.snapshot.run.snapshot_date,
    items: input.snapshot.items.map((item) => ({ ordinal: item.ordinal, steamAppId: item.steam_app_id })),
  });
  const selection = parsePublicationSelection(input.selection, { manifest, manifestHash: input.snapshot.run.manifest_hash });
  const candidatesBySteamId = bySteamId(input.candidates);
  const itemBySteamId = new Map(input.snapshot.items.map((item) => [item.steam_app_id, item]));
  const diagnostics: PublicationDiagnostic[] = [];
  const included: Array<{ steamAppId: string; game: SiteSnapshotGame }> = [];
  const excluded: PublicationGateResult["excluded"] = [];

  for (const item of selection.items) {
    const matches = candidatesBySteamId.get(item.steamAppId) ?? [];
    if (item.decision === "exclude") {
      excluded.push({ steamAppId: item.steamAppId, game: matches.length === 1 ? matches[0]! : null });
      continue;
    }
    if (matches.length === 0) {
      diagnostics.push(diagnostic(item.steamAppId, "identity_unavailable", "included Steam identity has no canonical candidate"));
      continue;
    }
    if (matches.length !== 1) {
      diagnostics.push(diagnostic(item.steamAppId, "identity_mismatch", "included Steam identity resolves to multiple canonical candidates"));
      continue;
    }
    const durable = itemBySteamId.get(item.steamAppId);
    if (!durable || durable.game_id !== matches[0]!.game.id) {
      diagnostics.push(diagnostic(item.steamAppId, "identity_mismatch", "durable run identity does not match canonical candidate"));
      continue;
    }
    const stages = parseItemStages(durable.stage_states_json);
    if (stages.evaluate.state !== "succeeded") {
      diagnostics.push(diagnostic(item.steamAppId, "evaluate_not_succeeded", "durable evaluate stage is not succeeded"));
      continue;
    }
    included.push({ steamAppId: item.steamAppId, game: matches[0]! });
  }

  const eligibility = evaluateGames(included.map((value) => value.game), manifest.snapshotDate);
  for (const [index, result] of eligibility.entries()) {
    for (const issue of result.diagnostics as EligibilityDiagnostic[]) {
      diagnostics.push({ steamAppId: included[index]!.steamAppId, code: issue.code, message: issue.message });
    }
  }
  const artifactGames = eligibility.flatMap((result) => result.published ? [result.published] : []);
  return { admitted: diagnostics.length === 0, artifactGames: diagnostics.length === 0 ? artifactGames : [], excluded, diagnostics: sortDiagnostics(diagnostics) };
}
