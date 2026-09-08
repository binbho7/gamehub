import type { LinkVerificationStore } from "../../db/repositories/link-verification";
import { createLinkVerificationResult } from "./classification";
import { LinkVerificationError } from "./errors";
import { normalizeCanonicalGameId } from "./input";
import { planGameLinkVerification } from "./plan";
import type {
  GameLinkVerificationResult,
  LinkVerificationResult,
} from "./types";
import type { VerifyUrl } from "./verifier";

const MAX_LINKS_PER_GAME = 20;
const LINK_DEADLINE_MS = 20_000;
const GAME_DEADLINE_MS = 5 * 60_000;

export type VerifyBoundUrl = (
  exactUrl: Parameters<VerifyUrl>[0],
  options?: Parameters<VerifyUrl>[2],
) => ReturnType<VerifyUrl>;

export type LinkVerificationService = {
  verifyGame(
    gameId: number,
    options?: { dryRun?: boolean },
  ): Promise<GameLinkVerificationResult>;
};

function writeStatus(
  affectedRows: number,
  conflictCount: number,
): GameLinkVerificationResult["status"] {
  if (affectedRows === 0) return "no_changes";
  return conflictCount === 0 ? "applied" : "partially_applied";
}

export function createLinkVerificationService(dependencies: {
  store: LinkVerificationStore;
  verifyUrl: VerifyBoundUrl;
  now?: () => Date;
}): LinkVerificationService {
  const now = dependencies.now ?? (() => new Date());

  return {
    async verifyGame(gameId, options = {}) {
      const normalizedGameId = normalizeCanonicalGameId(gameId);
      const snapshot = await dependencies.store.readGameLinks(normalizedGameId);

      if (!snapshot.gameExists) {
        throw new LinkVerificationError(
          "game_not_found",
          "Canonical GameHub game was not found",
        );
      }

      if (snapshot.links.length > MAX_LINKS_PER_GAME) {
        throw new LinkVerificationError(
          "link_limit_exceeded",
          "Canonical game has too many official links to verify",
        );
      }

      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), GAME_DEADLINE_MS);
      const results: LinkVerificationResult[] = [];

      try {
        for (const link of snapshot.links) {
          const terminal = await dependencies.verifyUrl(link.url, {
            linkDeadlineMs: LINK_DEADLINE_MS,
            signal: controller.signal,
          });
          results.push(createLinkVerificationResult(link, terminal));
        }
      } finally {
        clearTimeout(deadline);
      }

      const dryRun = options.dryRun ?? true;
      const plan = planGameLinkVerification({
        gameId: normalizedGameId,
        dryRun,
        snapshots: snapshot.links,
        results,
        now: now(),
      });

      if (dryRun) {
        return {
          gameId: normalizedGameId,
          dryRun: true,
          status: "planned",
          plan,
          affectedRows: 0,
          conflicts: [],
        };
      }

      const written = await dependencies.store.writePlan(plan);
      return {
        gameId: normalizedGameId,
        dryRun: false,
        status: writeStatus(written.affectedRows, written.conflicts.length),
        plan,
        affectedRows: written.affectedRows,
        conflicts: written.conflicts,
      };
    },
  };
}
