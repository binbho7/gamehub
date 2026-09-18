import { asc, eq } from "drizzle-orm";
import { LinkVerificationError } from "../../verifiers/official-links/errors";
import type {
  GameLinkVerificationPlan,
  LinkVerificationSnapshot,
  VerificationStatus,
  WriteConflict,
} from "../../verifiers/official-links/types";
import { createDatabase } from "../client";
import { gameOfficialLinks, games } from "../schema";
import { buildLinkVerificationQueries } from "./link-verification-queries";

const WRITE_FAILED_MESSAGE = "Unable to write link verification data";
const WRITE_INVARIANT_MESSAGE = "Link verification write invariant violated";

export type LinkVerificationWriteResult = {
  affectedRows: number;
  appliedLinkIds: number[];
  conflicts: WriteConflict[];
};

export type LinkVerificationStore = {
  readGameLinks(gameId: number): Promise<{
    gameExists: boolean;
    links: LinkVerificationSnapshot[];
  }>;
  writePlan(plan: GameLinkVerificationPlan): Promise<LinkVerificationWriteResult>;
};

export function createLinkVerificationStore(
  db: ReturnType<typeof createDatabase>,
): LinkVerificationStore {
  return {
    async readGameLinks(gameId) {
      try {
        const game = await db.select({ id: games.id })
          .from(games)
          .where(eq(games.id, gameId))
          .limit(1);
        if (game.length === 0) return { gameExists: false, links: [] };

        const rows = await db.select({
          id: gameOfficialLinks.id,
          gameId: gameOfficialLinks.gameId,
          url: gameOfficialLinks.url,
          updatedAt: gameOfficialLinks.updatedAt,
          verificationStatus: gameOfficialLinks.verificationStatus,
          verificationMethod: gameOfficialLinks.verificationMethod,
          httpStatus: gameOfficialLinks.httpStatus,
          redirectUrl: gameOfficialLinks.redirectUrl,
          verifiedAt: gameOfficialLinks.verifiedAt,
          lastCheckedAt: gameOfficialLinks.lastCheckedAt,
        })
          .from(gameOfficialLinks)
          .where(eq(gameOfficialLinks.gameId, gameId))
          .orderBy(asc(gameOfficialLinks.id));

        return {
          gameExists: true,
          links: rows.map((row) => ({
            ...row,
            verificationStatus: row.verificationStatus as VerificationStatus,
            verificationMethod: row.verificationMethod as
              | "manual"
              | "http"
              | "provider_api"
              | null,
          })),
        };
      } catch (cause) {
        throw new LinkVerificationError(
          "database_unavailable",
          "Unable to read link verification data",
          { cause },
        );
      }
    },

    async writePlan(plan) {
      type BatchQuery = Parameters<typeof db.batch>[0][number];
      const updates = buildLinkVerificationQueries(db, plan);

      if (updates.length === 0) {
        return { affectedRows: 0, appliedLinkIds: [], conflicts: [] };
      }

      let results;
      try {
        results = await db.batch(updates.map(({ legacyQuery }) => legacyQuery) as [
          BatchQuery,
          ...BatchQuery[],
        ]);
      } catch (cause) {
        throw new LinkVerificationError(
          "write_failed",
          WRITE_FAILED_MESSAGE,
          { cause },
        );
      }

      let affectedRows = 0;
      const appliedLinkIds: number[] = [];
      const conflicts: WriteConflict[] = [];
      for (const [index, update] of updates.entries()) {
        const changes = results[index]?.meta.changes;
        if (changes === 1) {
          affectedRows += 1;
          appliedLinkIds.push(update.linkId);
          continue;
        }
        if (changes === 0) {
          conflicts.push({ linkId: update.linkId, code: "write_conflict" });
          continue;
        }
        throw new LinkVerificationError(
          "write_failed",
          WRITE_INVARIANT_MESSAGE,
        );
      }

      return { affectedRows, appliedLinkIds, conflicts };
    },
  };
}
