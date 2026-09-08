import type {
  GameLinkVerificationPlan,
  LinkVerificationResult,
  LinkVerificationSnapshot,
  LinkVerificationUpdate,
} from "./types";

const INVARIANT_MESSAGE = "Link verification plan invariant violated";

function invariantViolation(): never {
  throw new Error(INVARIANT_MESSAGE);
}

function datesEqual(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

function metadataMatches(
  snapshot: LinkVerificationSnapshot,
  changes: LinkVerificationUpdate,
): boolean {
  return snapshot.verificationStatus === changes.verificationStatus &&
    snapshot.verificationMethod === changes.verificationMethod &&
    snapshot.httpStatus === changes.httpStatus &&
    snapshot.redirectUrl === changes.redirectUrl &&
    datesEqual(snapshot.verifiedAt, changes.verifiedAt) &&
    datesEqual(snapshot.lastCheckedAt, changes.lastCheckedAt);
}

function changesFor(
  snapshot: LinkVerificationSnapshot,
  result: LinkVerificationResult,
  updatedAt: Date,
): LinkVerificationUpdate {
  return {
    verificationStatus: result.classification,
    verificationMethod: "http",
    httpStatus: result.httpStatus,
    redirectUrl: result.code === "http_result" && result.redirectChain.length > 0
      ? result.finalUrl
      : null,
    verifiedAt: result.classification === "verified"
      ? result.checkedAt
      : snapshot.verifiedAt,
    lastCheckedAt: result.checkedAt,
    updatedAt,
  };
}

export function planGameLinkVerification(input: {
  gameId: number;
  dryRun: boolean;
  snapshots: LinkVerificationSnapshot[];
  results: LinkVerificationResult[];
  now: Date;
}): GameLinkVerificationPlan {
  if (input.snapshots.length !== input.results.length) return invariantViolation();

  const resultsByLinkId = new Map<number, LinkVerificationResult>();
  for (const result of input.results) {
    if (resultsByLinkId.has(result.linkId)) return invariantViolation();
    resultsByLinkId.set(result.linkId, result);
  }

  const seenSnapshots = new Set<number>();
  const items = input.snapshots.map((snapshot) => {
    if (seenSnapshots.has(snapshot.id)) return invariantViolation();
    seenSnapshots.add(snapshot.id);

    const result = resultsByLinkId.get(snapshot.id);
    if (
      result === undefined ||
      snapshot.gameId !== input.gameId ||
      result.gameId !== input.gameId ||
      result.originalUrl !== snapshot.url
    ) {
      return invariantViolation();
    }

    if (snapshot.verificationMethod === "manual") {
      return {
        action: "skip" as const,
        linkId: snapshot.id,
        originalUrl: snapshot.url,
        reason: "manual_verification_preserved" as const,
      };
    }

    const changes = changesFor(snapshot, result, input.now);
    if (metadataMatches(snapshot, changes)) {
      return {
        action: "skip" as const,
        linkId: snapshot.id,
        originalUrl: snapshot.url,
        reason: "no_metadata_change" as const,
      };
    }

    return { action: "update" as const, snapshot, changes };
  });

  return {
    gameId: input.gameId,
    dryRun: input.dryRun,
    linksRead: input.snapshots.length,
    verificationResults: input.results,
    items,
  };
}
