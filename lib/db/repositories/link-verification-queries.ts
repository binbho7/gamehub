import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { GameLinkVerificationPlan } from "../../verifiers/official-links/types";
import type { GameHubDatabase } from "../client";
import { gameOfficialLinks } from "../schema";
import { compileDomainQuery, type BuiltDomainQuery } from "./scheduled/fence";

export function buildLinkVerificationQueries(
  db: GameHubDatabase,
  plan: GameLinkVerificationPlan,
  guard?: SQL,
): Array<BuiltDomainQuery & { linkId: number }> {
  return plan.items.flatMap((item) => {
    if (item.action === "skip") return [];
    const { changes, snapshot } = item;
    const query = db.update(gameOfficialLinks).set({
      verificationStatus: changes.verificationStatus,
      verificationMethod: changes.verificationMethod,
      httpStatus: changes.httpStatus,
      redirectUrl: changes.redirectUrl,
      verifiedAt: changes.verifiedAt,
      lastCheckedAt: changes.lastCheckedAt,
      updatedAt: changes.updatedAt,
    }).where(and(
      guard,
      eq(gameOfficialLinks.id, snapshot.id),
      eq(gameOfficialLinks.gameId, plan.gameId),
      eq(gameOfficialLinks.gameId, snapshot.gameId),
      eq(gameOfficialLinks.url, snapshot.url),
      eq(gameOfficialLinks.updatedAt, snapshot.updatedAt),
      eq(gameOfficialLinks.verificationStatus, snapshot.verificationStatus),
      snapshot.verificationMethod === null
        ? isNull(gameOfficialLinks.verificationMethod)
        : eq(gameOfficialLinks.verificationMethod, snapshot.verificationMethod),
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
    ));
    return [{ linkId: snapshot.id, ...compileDomainQuery(query, { minChanges: 0, maxChanges: 1 }) }];
  });
}
