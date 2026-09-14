import { LinkVerificationError } from "../verifiers/official-links/errors";
import type {
  GameLinkVerificationResult,
  VerificationCode,
} from "../verifiers/official-links/types";
import {
  isStageError,
  stageError,
  type CanonicalSyncStage,
  type LinkVerifierPort,
  type StageContext,
} from "./stages";

const LINK_STATUSES = ["planned", "applied", "partially_applied", "no_changes"] as const;
const LINK_CLASSIFICATIONS = [
  "verified", "reachable_but_unverified", "broken", "temporarily_unavailable", "unsafe", "unknown",
] as const;
const VERIFICATION_CODES = [
  "http_result", "invalid_url", "unsupported_scheme", "unsafe_destination", "dns_failure",
  "timeout", "network_error", "tls_error", "redirect_loop", "too_many_redirects",
  "invalid_redirect", "protocol_downgrade",
] as const;
const OPERATION_FAILURE_CODES = VERIFICATION_CODES.filter((code) => code !== "http_result");

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isValidResult(
  value: unknown,
  gameId: number,
  context: StageContext,
): value is GameLinkVerificationResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.gameId !== gameId || result.dryRun !== context.dryRun) return false;
  if (!isOneOf(LINK_STATUSES, result.status)) return false;
  if (typeof result.plan !== "object" || result.plan === null) return false;
  const plan = result.plan as Record<string, unknown>;
  if (plan.gameId !== gameId || plan.dryRun !== context.dryRun) return false;
  if (!Array.isArray(plan.verificationResults) || !Array.isArray(plan.items)) return false;
  if (!Array.isArray(result.conflicts)) return false;
  return plan.verificationResults.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return item.gameId === gameId
      && isOneOf(LINK_CLASSIFICATIONS, item.classification)
      && isOneOf(VERIFICATION_CODES, item.code);
  });
}

export function createLinkStage(verifier: LinkVerifierPort): CanonicalSyncStage {
  return {
    async execute(gameId, context) {
      try {
        const result = await verifier.verifyGame(gameId, { dryRun: context.dryRun });
        if (!isValidResult(result, gameId, context)) throw stageError("links", "invalid_result");
        if (result.conflicts.length > 0) throw stageError("links", "write_conflict");
        if (result.status === "partially_applied") throw stageError("links", "partially_applied");

        const operation = result.plan.verificationResults.find((item) =>
          isOneOf(OPERATION_FAILURE_CODES, item.code),
        );
        if (operation) throw stageError("links", operation.code as Exclude<VerificationCode, "http_result">);

        const counts = LINK_CLASSIFICATIONS
          .map((classification) => [classification,
            result.plan.verificationResults.filter((item) => item.classification === classification).length] as const)
          .filter(([, count]) => count > 0)
          .map(([classification, count]) => `${classification}=${count}`);
        const suffix = counts.length > 0 ? `; ${counts.join("; ")}` : "";
        return { summary: `Links ${result.status}; checked=${result.plan.verificationResults.length}${suffix}.` };
      } catch (error) {
        if (isStageError(error, "links")) throw error;
        if (error instanceof LinkVerificationError) throw stageError("links", error.code);
        throw stageError("links", "unexpected_error");
      }
    },
  };
}
