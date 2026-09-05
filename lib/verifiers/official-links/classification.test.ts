import { describe, expect, it } from "vitest";
import type {
  LinkVerificationSnapshot,
  TerminalOutcome,
  VerificationClassification,
  VerificationCode,
} from "./types";
import {
  classifyTerminalOutcome,
  createLinkVerificationResult,
} from "./classification";

const CHECKED_AT = new Date("2026-09-05T00:00:00.000Z");
const SECRET_URL = "https://www.example.test/path?token=classification-secret";

function integerRange(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

function terminalOutcome(
  code: VerificationCode = "http_result",
  httpStatus: number | null = null,
): TerminalOutcome {
  return {
    code,
    attempts: [],
    redirectChain: [],
    finalUrl: code === "http_result" ? SECRET_URL : null,
    httpStatus,
    checkedAt: CHECKED_AT,
  };
}

const snapshot: LinkVerificationSnapshot = {
  id: 42,
  gameId: 7,
  url: SECRET_URL,
  updatedAt: new Date("2026-09-04T00:00:00.000Z"),
  verificationStatus: "verified",
  verificationMethod: "manual",
  httpStatus: 200,
  redirectUrl: null,
  verifiedAt: new Date("2026-09-03T00:00:00.000Z"),
  lastCheckedAt: new Date("2026-09-03T00:00:00.000Z"),
};

describe("classifyTerminalOutcome", () => {
  it.each(integerRange(200, 299))("classifies HTTP %i as verified", (status) => {
    expect(classifyTerminalOutcome(terminalOutcome("http_result", status))).toBe("verified");
  });

  it.each(integerRange(300, 399))(
    "classifies non-followed HTTP %i as reachable but unverified",
    (status) => {
      expect(classifyTerminalOutcome(terminalOutcome("http_result", status)))
        .toBe("reachable_but_unverified");
    },
  );

  it.each([
    400, 401, 402, 403,
    ...integerRange(405, 407),
    409,
    ...integerRange(411, 424),
    ...integerRange(426, 428),
    ...integerRange(430, 499),
  ])("classifies ordinary HTTP %i as reachable but unverified", (status) => {
    expect(classifyTerminalOutcome(terminalOutcome("http_result", status)))
      .toBe("reachable_but_unverified");
  });

  it.each([
    [404, "broken"],
    [410, "broken"],
    [408, "temporarily_unavailable"],
    [425, "temporarily_unavailable"],
    [429, "temporarily_unavailable"],
  ] as const)("classifies special HTTP %i as %s", (status, expected) => {
    expect(classifyTerminalOutcome(terminalOutcome("http_result", status))).toBe(expected);
  });

  it.each(integerRange(500, 599))(
    "classifies HTTP %i as temporarily unavailable",
    (status) => {
      expect(classifyTerminalOutcome(terminalOutcome("http_result", status)))
        .toBe("temporarily_unavailable");
    },
  );

  it.each([
    ["invalid_redirect", "broken"],
    ["redirect_loop", "broken"],
    ["too_many_redirects", "broken"],
    ["invalid_url", "unsafe"],
    ["unsupported_scheme", "unsafe"],
    ["unsafe_destination", "unsafe"],
    ["protocol_downgrade", "unsafe"],
    ["timeout", "temporarily_unavailable"],
    ["dns_failure", "unknown"],
    ["tls_error", "unknown"],
    ["network_error", "unknown"],
  ] as const)("classifies terminal code %s as %s", (code, expected) => {
    expect(classifyTerminalOutcome(terminalOutcome(code))).toBe(expected);
  });

  it("rejects an HTTP terminal outcome without a status using a sanitized invariant", () => {
    let message = "";

    try {
      classifyTerminalOutcome(terminalOutcome("http_result"));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe("Link verification classification invariant violated");
    expect(message).not.toContain(SECRET_URL);
    expect(message).not.toContain("classification-secret");
  });
});

describe("createLinkVerificationResult", () => {
  it.each([
    [418, "reachable_but_unverified"],
    [503, "temporarily_unavailable"],
  ] as const)("returns a result for ordinary HTTP %i instead of throwing", (status, expected) => {
    const outcome = terminalOutcome("http_result", status);

    expect(() => createLinkVerificationResult(snapshot, outcome)).not.toThrow();
    expect(createLinkVerificationResult(snapshot, outcome)).toEqual({
      ...outcome,
      linkId: 42,
      gameId: 7,
      originalUrl: SECRET_URL,
      classification: expected,
    });
  });

  it("creates a runtime result even when a snapshot has manual verification", () => {
    const outcome = terminalOutcome("http_result", 204);

    expect(createLinkVerificationResult(snapshot, outcome)).toEqual({
      ...outcome,
      linkId: 42,
      gameId: 7,
      originalUrl: SECRET_URL,
      classification: "verified",
    });
  });

  it("never emits a legacy verification status", () => {
    const classifications: VerificationClassification[] = [
      ...integerRange(200, 599).map((status) =>
        classifyTerminalOutcome(terminalOutcome("http_result", status))),
      ...([
        "invalid_redirect",
        "redirect_loop",
        "too_many_redirects",
        "invalid_url",
        "unsupported_scheme",
        "unsafe_destination",
        "protocol_downgrade",
        "timeout",
        "dns_failure",
        "tls_error",
        "network_error",
      ] as const).map((code) => classifyTerminalOutcome(terminalOutcome(code))),
    ];

    expect(classifications).not.toContain("failed");
    expect(classifications).not.toContain("unverified");
    expect(classifications).not.toContain("pending");
  });
});
