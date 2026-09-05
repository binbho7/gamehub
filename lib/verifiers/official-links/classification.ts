import type {
  LinkVerificationResult,
  LinkVerificationSnapshot,
  TerminalOutcome,
  VerificationClassification,
} from "./types";

const INVARIANT_MESSAGE = "Link verification classification invariant violated";

function invariantViolation(): never {
  throw new Error(INVARIANT_MESSAGE);
}

function classifyHttpStatus(httpStatus: number | null): VerificationClassification {
  if (httpStatus === null) return invariantViolation();

  if (httpStatus >= 200 && httpStatus <= 299) return "verified";
  if (httpStatus >= 300 && httpStatus <= 399) return "reachable_but_unverified";
  if (httpStatus === 404 || httpStatus === 410) return "broken";
  if (httpStatus === 408 || httpStatus === 425 || httpStatus === 429) {
    return "temporarily_unavailable";
  }
  if (httpStatus >= 400 && httpStatus <= 499) return "reachable_but_unverified";
  if (httpStatus >= 500 && httpStatus <= 599) return "temporarily_unavailable";

  return "unknown";
}

function assertUnreachableCode(code: never): never {
  void code;
  return invariantViolation();
}

export function classifyTerminalOutcome(
  outcome: TerminalOutcome,
): VerificationClassification {
  switch (outcome.code) {
    case "http_result":
      return classifyHttpStatus(outcome.httpStatus);
    case "invalid_redirect":
    case "redirect_loop":
    case "too_many_redirects":
      return "broken";
    case "invalid_url":
    case "unsupported_scheme":
    case "unsafe_destination":
    case "protocol_downgrade":
      return "unsafe";
    case "timeout":
      return "temporarily_unavailable";
    case "dns_failure":
    case "tls_error":
    case "network_error":
      return "unknown";
    default:
      return assertUnreachableCode(outcome.code);
  }
}

export function createLinkVerificationResult(
  snapshot: LinkVerificationSnapshot,
  outcome: TerminalOutcome,
): LinkVerificationResult {
  return {
    ...outcome,
    linkId: snapshot.id,
    gameId: snapshot.gameId,
    originalUrl: snapshot.url,
    classification: classifyTerminalOutcome(outcome),
  };
}
