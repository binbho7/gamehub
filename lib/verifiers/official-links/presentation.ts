import type {
  GameLinkVerificationResult,
  LinkVerificationResult,
  PresentedGameLinkVerificationResult,
  PresentedLinkVerificationResult,
  PresentedPlanItem,
} from "./types";

const REDACTED_URL = "[REDACTED_URL]";
const REDACTED_VALUE = "[REDACTED]";
const HTTP_LIKE_URL_TOKEN = /\bhttps?:\S+/gi;
const HTTP_URL_WITH_AUTHORITY = /^https?:\/\/[^/?#]/i;
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "auth",
  "authorization",
  "key",
  "api_key",
  "apikey",
  "signature",
  "sig",
  "secret",
  "credential",
  "x-amz-signature",
  "x-amz-credential",
]);

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function sanitizeUrlForPresentation(raw: string): string {
  let sanitized: URL;
  try {
    sanitized = new URL(raw);
  } catch {
    return REDACTED_URL;
  }

  sanitized.username = "";
  sanitized.password = "";
  sanitized.hash = "";

  const query = new URLSearchParams();
  for (const [key, value] of sanitized.searchParams) {
    query.append(
      key,
      SENSITIVE_QUERY_KEYS.has(asciiLowercase(key)) ? REDACTED_VALUE : value,
    );
  }
  sanitized.search = query.toString();

  return sanitized.href.replaceAll("%5BREDACTED%5D", REDACTED_VALUE);
}

function sanitizeHttpLikeUrlToken(raw: string): string {
  return HTTP_URL_WITH_AUTHORITY.test(raw)
    ? sanitizeUrlForPresentation(raw)
    : REDACTED_URL;
}

export function sanitizeTextForPresentation(raw: string): string {
  const urlTokens = raw.match(HTTP_LIKE_URL_TOKEN);
  if (urlTokens === null) return raw;

  const sanitizedTokens = urlTokens.map(sanitizeHttpLikeUrlToken);
  if (sanitizedTokens.includes(REDACTED_URL)) return REDACTED_URL;

  let tokenIndex = 0;
  return raw.replace(HTTP_LIKE_URL_TOKEN, () => sanitizedTokens[tokenIndex++] ?? REDACTED_URL);
}

function presentLinkResult(result: LinkVerificationResult): PresentedLinkVerificationResult {
  return {
    linkId: result.linkId,
    gameId: result.gameId,
    originalUrl: sanitizeUrlForPresentation(result.originalUrl),
    classification: result.classification,
    code: result.code,
    attempts: result.attempts.map((attempt) => ({
      method: attempt.method,
      url: sanitizeUrlForPresentation(attempt.url),
      resolvedAddress: attempt.resolvedAddress,
      addressFamily: attempt.addressFamily,
      httpStatus: attempt.httpStatus,
      startedAt: attempt.startedAt.toISOString(),
      finishedAt: attempt.finishedAt.toISOString(),
    })),
    redirectChain: result.redirectChain.map((hop) => ({
      fromUrl: sanitizeUrlForPresentation(hop.fromUrl),
      status: hop.status,
      location: sanitizeUrlForPresentation(hop.location),
      resolvedUrl:
        hop.resolvedUrl === null ? null : sanitizeUrlForPresentation(hop.resolvedUrl),
    })),
    finalUrl:
      result.finalUrl === null ? null : sanitizeUrlForPresentation(result.finalUrl),
    httpStatus: result.httpStatus,
    checkedAt: result.checkedAt.toISOString(),
  };
}

function presentPlanItem(
  item: GameLinkVerificationResult["plan"]["items"][number],
): PresentedPlanItem {
  if (item.action === "skip") {
    return {
      action: "skip",
      linkId: item.linkId,
      originalUrl: sanitizeUrlForPresentation(item.originalUrl),
      reason: item.reason,
    };
  }

  return {
    action: "update",
    linkId: item.snapshot.id,
    originalUrl: sanitizeUrlForPresentation(item.snapshot.url),
    changes: {
      verificationStatus: item.changes.verificationStatus,
      verificationMethod: item.changes.verificationMethod,
      httpStatus: item.changes.httpStatus,
      redirectUrl:
        item.changes.redirectUrl === null
          ? null
          : sanitizeUrlForPresentation(item.changes.redirectUrl),
      verifiedAt: item.changes.verifiedAt?.toISOString() ?? null,
      lastCheckedAt: item.changes.lastCheckedAt.toISOString(),
      updatedAt: item.changes.updatedAt.toISOString(),
    },
  };
}

export function presentGameLinkVerificationResult(
  result: GameLinkVerificationResult,
): PresentedGameLinkVerificationResult {
  return {
    gameId: result.gameId,
    dryRun: result.dryRun,
    status: result.status,
    links: result.plan.verificationResults.map(presentLinkResult),
    planItems: result.plan.items.map(presentPlanItem),
    affectedRows: result.affectedRows,
    conflicts: result.conflicts.map((conflict) => ({
      linkId: conflict.linkId,
      code: conflict.code,
    })),
  };
}
