import { asc, eq } from "drizzle-orm";
import { LinkVerificationError } from "../../verifiers/official-links/errors";
import type {
  LinkVerificationSnapshot,
  VerificationStatus,
} from "../../verifiers/official-links/types";
import { createDatabase } from "../client";
import { gameOfficialLinks, games } from "../schema";

export type LinkVerificationStore = {
  readGameLinks(gameId: number): Promise<{
    gameExists: boolean;
    links: LinkVerificationSnapshot[];
  }>;
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
  };
}
