import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { LinkVerificationError } from "../../verifiers/official-links/errors";
import type {
  GameLinkVerificationPlan,
  LinkVerificationSnapshot,
  VerificationStatus,
  WriteConflict,
} from "../../verifiers/official-links/types";
import { createDatabase } from "../client";
import { gameOfficialLinks, games } from "../schema";

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
      const updates: Array<{ linkId: number; query: BatchQuery }> = [];

      for (const item of plan.items) {
        if (item.action === "skip") continue;

        const { changes, snapshot } = item;
        const values = {
          verificationStatus: changes.verificationStatus,
          verificationMethod: changes.verificationMethod,
          httpStatus: changes.httpStatus,
          redirectUrl: changes.redirectUrl,
          verifiedAt: changes.verifiedAt,
          lastCheckedAt: changes.lastCheckedAt,
          updatedAt: changes.updatedAt,
        } satisfies Pick<
          typeof gameOfficialLinks.$inferInsert,
          | "verificationStatus"
          | "verificationMethod"
          | "httpStatus"
          | "redirectUrl"
          | "verifiedAt"
          | "lastCheckedAt"
          | "updatedAt"
        >;

        updates.push({
          linkId: snapshot.id,
          query: db.update(gameOfficialLinks)
            .set(values)
            .where(and(
              eq(gameOfficialLinks.id, snapshot.id),
              eq(gameOfficialLinks.gameId, plan.gameId),
              eq(gameOfficialLinks.gameId, snapshot.gameId),
              eq(gameOfficialLinks.url, snapshot.url),
              eq(gameOfficialLinks.updatedAt, snapshot.updatedAt),
              eq(
                gameOfficialLinks.verificationStatus,
                snapshot.verificationStatus,
              ),
              snapshot.verificationMethod === null
                ? isNull(gameOfficialLinks.verificationMethod)
                : eq(
                  gameOfficialLinks.verificationMethod,
                  snapshot.verificationMethod,
                ),
              snapshot.httpStatus === null
                ? isNull(gameOfficialLinks.httpStatus)
                : eq(gameOfficialLinks.httpStatus, snapshot.httpStatus),
              snapshot.redirectUrl === null
                ? isNull(gameOfficialLinks.redirectUrl)
                : eq(gameOfficialLinks.redirectUrl, snapshot.redirectUrl),
              snapshot.verifiedAt === null
                ? isNull(gameOfficialLinks.verifiedAt)
                : eq(gameOfficialLinks.verifiedAt, snapshot.verifiedAt),
              snapshot.lastCheckedAt === null
                ? isNull(gameOfficialLinks.lastCheckedAt)
                : eq(gameOfficialLinks.lastCheckedAt, snapshot.lastCheckedAt),
              sql`${gameOfficialLinks.verificationMethod} is not 'manual'`,
            )),
        });
      }

      if (updates.length === 0) {
        return { affectedRows: 0, appliedLinkIds: [], conflicts: [] };
      }

      let results;
      try {
        results = await db.batch(updates.map(({ query }) => query) as [
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
