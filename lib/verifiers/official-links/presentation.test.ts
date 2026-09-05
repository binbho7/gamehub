import { describe, expect, it } from "vitest";
import type { GameLinkVerificationResult } from "./types";
import {
  presentGameLinkVerificationResult,
  sanitizeTextForPresentation,
  sanitizeUrlForPresentation,
} from "./presentation";

const sensitiveKeys = [
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
] as const;

function secretUrl(label: string): { url: string; markers: string[] } {
  const markers = sensitiveKeys.flatMap((key, index) => [
    `${label}-${index}-first-marker`,
    `${label}-${index}-repeated-marker`,
  ]);
  const query = sensitiveKeys
    .flatMap((key, index) => [
      `${index % 2 === 0 ? key.toUpperCase() : key}=${markers[index * 2]}`,
      `${key}=${markers[index * 2 + 1]}`,
    ])
    .concat("view=public")
    .join("&");

  return {
    url: `https://present-user:present-password@example.com/${label}?${query}#${label}-fragment`,
    markers,
  };
}

function malformedSecretQuery(label: string): { query: string; markers: string[] } {
  const markers = sensitiveKeys.map((key, index) => `${label}-${index}-secret-marker`);
  const query = sensitiveKeys
    .map((key, index) => `${index % 2 === 0 ? key.toUpperCase() : key}=${markers[index]}`)
    .join("&");

  return { query, markers };
}

describe("sanitizeUrlForPresentation", () => {
  it("removes credentials and fragments and redacts every repeated sensitive value", () => {
    const secret = secretUrl("standalone");

    const presented = sanitizeUrlForPresentation(secret.url);

    expect(presented).toContain("[REDACTED]");
    expect(presented).toContain("view=public");
    expect(presented.match(/\[REDACTED\]/g)).toHaveLength(sensitiveKeys.length * 2);
    expect(presented).not.toContain("present-user");
    expect(presented).not.toContain("present-password");
    expect(presented).not.toContain("standalone-fragment");
    for (const marker of secret.markers) expect(presented).not.toContain(marker);
  });

  it("produces the hand-derived presentation form for a representative URL", () => {
    expect(
      sanitizeUrlForPresentation(
        "https://url-user:url-pass@example.com/path?ToKeN=first&TOKEN=second&view=public#fragment",
      ),
    ).toBe(
      "https://example.com/path?ToKeN=[REDACTED]&TOKEN=[REDACTED]&view=public",
    );
  });

  it("returns a constant placeholder for malformed input without echoing it", () => {
    const malformed = "http://[ MALFORMED-RAW-SECRET token=do-not-echo";

    expect(sanitizeUrlForPresentation(malformed)).toBe("[REDACTED_URL]");
    expect(sanitizeUrlForPresentation(malformed)).not.toContain(malformed);
  });
});

describe("sanitizeTextForPresentation", () => {
  it("sanitizes an URL embedded in error-facing text", () => {
    const raw =
      "Verification failed for https://error-user:error-pass@example.com/path?ToKeN=error-marker#visible-fragment after redirect";

    const presented = sanitizeTextForPresentation(raw);

    expect(presented).toBe(
      "Verification failed for https://example.com/path?ToKeN=[REDACTED] after redirect",
    );
  });

  it("replaces a malformed URL-looking token instead of echoing it", () => {
    const raw = "Verification failed for https://[malformed-secret";

    const presented = sanitizeTextForPresentation(raw);

    expect(presented).toBe("[REDACTED_URL]");
    expect(presented).not.toContain("malformed-secret");
  });

  it.each([
    ["one-slash", "https:/malformed-one-slash-raw-secret"],
    ["no-slashes", "http:malformed-no-slashes-raw-secret"],
    ["extra-slash", "HTTPS:///malformed-extra-slash-raw-secret"],
    ["invalid-authority", "http://[malformed-authority-raw-secret"],
  ] as const)(
    "fails closed for the %s malformed HTTP-like form",
    (label, malformedUrl) => {
      const secret = malformedSecretQuery(label);
      const fragment = `${label}-fragment-secret`;
      const raw = `Verification failed for ${malformedUrl}?${secret.query}#${fragment} after redirect`;

      const presented = sanitizeTextForPresentation(raw);

      expect(presented).toBe("[REDACTED_URL]");
      expect(presented).not.toContain("raw-secret");
      expect(presented).not.toContain(fragment);
      for (const marker of secret.markers) expect(presented).not.toContain(marker);
    },
  );

  it.each([
    ["invalid-bracket", "https://["],
    ["empty-authority", "http://"],
    ["unclosed-ipv6", "HTTPS://[2001:db8::1"],
  ] as const)(
    "redacts the entire error text when whitespace splits a %s URL",
    (label, malformedPrefix) => {
      const rawMarker = `${label}-raw-secret`;
      const queryMarker = `${label}-query-secret`;
      const fragment = `${label}-fragment-secret`;
      const raw =
        `Verification failed for ${malformedPrefix} ${rawMarker}` +
        `?ToKeN=${queryMarker}#${fragment} after redirect`;

      const presented = sanitizeTextForPresentation(raw);

      expect(presented).toBe("[REDACTED_URL]");
      expect(presented).not.toContain(rawMarker);
      expect(presented).not.toContain(queryMarker);
      expect(presented).not.toContain(fragment);
    },
  );

  it("redacts the entire error text when a malformed URL follows a valid URL", () => {
    const raw =
      "First https://example.com/path?token=valid-secret then " +
      "https://[ split-raw-secret?AuTh=split-query-secret#split-fragment-secret";

    const presented = sanitizeTextForPresentation(raw);

    expect(presented).toBe("[REDACTED_URL]");
    expect(presented).not.toContain("valid-secret");
    expect(presented).not.toContain("split-raw-secret");
    expect(presented).not.toContain("split-query-secret");
    expect(presented).not.toContain("split-fragment-secret");
  });

  it("leaves ordinary prose containing HTTP and HTTPS labels unchanged", () => {
    const safeProse =
      "HTTP status checks passed; HTTPS: protocol support stayed enabled; https_status is healthy.";

    expect(sanitizeTextForPresentation(safeProse)).toBe(safeProse);
  });
});

describe("presentGameLinkVerificationResult", () => {
  it("constructs a fresh JSON-ready DTO with every URL-bearing field sanitized", () => {
    const original = secretUrl("original");
    const attempt = secretUrl("attempt");
    const from = secretUrl("from");
    const location = secretUrl("location");
    const resolved = secretUrl("resolved");
    const final = secretUrl("final");
    const snapshot = secretUrl("snapshot");
    const snapshotRedirect = secretUrl("snapshot-redirect");
    const changeRedirect = secretUrl("change-redirect");
    const skipped = secretUrl("skipped");
    const allMarkers = [
      ...original.markers,
      ...attempt.markers,
      ...from.markers,
      ...location.markers,
      ...resolved.markers,
      ...final.markers,
      ...snapshot.markers,
      ...snapshotRedirect.markers,
      ...changeRedirect.markers,
      ...skipped.markers,
    ];
    const checkedAt = new Date("2026-09-04T10:00:00.000Z");
    const startedAt = new Date("2026-09-04T10:00:01.000Z");
    const finishedAt = new Date("2026-09-04T10:00:02.000Z");
    const updatedAt = new Date("2026-09-03T09:00:00.000Z");
    const result: GameLinkVerificationResult = {
      gameId: 42,
      dryRun: false,
      status: "partially_applied",
      plan: {
        gameId: 42,
        dryRun: false,
        linksRead: 2,
        verificationResults: [
          {
            linkId: 7,
            gameId: 42,
            originalUrl: original.url,
            classification: "verified",
            code: "http_result",
            attempts: [
              {
                method: "HEAD",
                url: attempt.url,
                resolvedAddress: "203.0.113.10",
                addressFamily: 4,
                httpStatus: 200,
                startedAt,
                finishedAt,
              },
            ],
            redirectChain: [
              {
                fromUrl: from.url,
                status: 302,
                location: location.url,
                resolvedUrl: resolved.url,
              },
            ],
            finalUrl: final.url,
            httpStatus: 200,
            checkedAt,
          },
        ],
        items: [
          {
            action: "update",
            snapshot: {
              id: 7,
              gameId: 42,
              url: snapshot.url,
              updatedAt,
              verificationStatus: "pending",
              verificationMethod: null,
              httpStatus: null,
              redirectUrl: snapshotRedirect.url,
              verifiedAt: null,
              lastCheckedAt: null,
            },
            changes: {
              verificationStatus: "verified",
              verificationMethod: "http",
              httpStatus: 200,
              redirectUrl: changeRedirect.url,
              verifiedAt: checkedAt,
              lastCheckedAt: checkedAt,
              updatedAt: checkedAt,
            },
          },
          {
            action: "skip",
            linkId: 8,
            originalUrl: skipped.url,
            reason: "manual_verification_preserved",
          },
          {
            action: "skip",
            linkId: 9,
            originalUrl: "http://[ malformed-plan-secret",
            reason: "no_metadata_change",
          },
        ],
      },
      affectedRows: 1,
      conflicts: [{ linkId: 8, code: "write_conflict" }],
    };
    const internalBefore = JSON.stringify(result);

    const presented = presentGameLinkVerificationResult(result);
    const rendered = JSON.stringify(presented);

    expect(presented).toEqual({
      gameId: 42,
      dryRun: false,
      status: "partially_applied",
      links: [
        {
          linkId: 7,
          gameId: 42,
          originalUrl: expect.stringContaining("/original?"),
          classification: "verified",
          code: "http_result",
          attempts: [
            {
              method: "HEAD",
              url: expect.stringContaining("/attempt?"),
              resolvedAddress: "203.0.113.10",
              addressFamily: 4,
              httpStatus: 200,
              startedAt: "2026-09-04T10:00:01.000Z",
              finishedAt: "2026-09-04T10:00:02.000Z",
            },
          ],
          redirectChain: [
            {
              fromUrl: expect.stringContaining("/from?"),
              status: 302,
              location: expect.stringContaining("/location?"),
              resolvedUrl: expect.stringContaining("/resolved?"),
            },
          ],
          finalUrl: expect.stringContaining("/final?"),
          httpStatus: 200,
          checkedAt: "2026-09-04T10:00:00.000Z",
        },
      ],
      planItems: [
        {
          action: "update",
          linkId: 7,
          originalUrl: expect.stringContaining("/snapshot?"),
          changes: {
            verificationStatus: "verified",
            verificationMethod: "http",
            httpStatus: 200,
            redirectUrl: expect.stringContaining("/change-redirect?"),
            verifiedAt: "2026-09-04T10:00:00.000Z",
            lastCheckedAt: "2026-09-04T10:00:00.000Z",
            updatedAt: "2026-09-04T10:00:00.000Z",
          },
        },
        {
          action: "skip",
          linkId: 8,
          originalUrl: expect.stringContaining("/skipped?"),
          reason: "manual_verification_preserved",
        },
        {
          action: "skip",
          linkId: 9,
          originalUrl: "[REDACTED_URL]",
          reason: "no_metadata_change",
        },
      ],
      affectedRows: 1,
      conflicts: [{ linkId: 8, code: "write_conflict" }],
    });
    expect(rendered).toContain("[REDACTED]");
    expect(rendered).not.toContain("present-user");
    expect(rendered).not.toContain("present-password");
    expect(rendered).not.toContain("fragment");
    expect(rendered).not.toContain("malformed-plan-secret");
    for (const marker of allMarkers) expect(rendered).not.toContain(marker);
    expect(JSON.stringify(result)).toBe(internalBefore);
    expect(result.plan.verificationResults[0]?.originalUrl).toBe(original.url);
    expect(result.plan.items[0]?.action).toBe("update");
    if (result.plan.items[0]?.action === "update") {
      expect(result.plan.items[0].snapshot.redirectUrl).toBe(snapshotRedirect.url);
    }
  });
});
