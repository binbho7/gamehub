import { describe, expect, it } from "vitest";
import type {
  LinkVerificationResult,
  LinkVerificationSnapshot,
  VerificationClassification,
  VerificationCode,
} from "./types";
import { planGameLinkVerification } from "./plan";

const HISTORICAL_VERIFIED_AT = new Date("2026-09-03T00:00:00.000Z");
const SNAPSHOT_CHECKED_AT = new Date("2026-09-04T00:00:00.000Z");
const RESULT_CHECKED_AT = new Date("2026-09-05T10:00:00.000Z");
const PLAN_UPDATED_AT = new Date("2026-09-05T10:00:01.000Z");
const EXACT_URL =
  "https://exact-user:exact-password@example.com/path?token=exact-secret#fragment";

function snapshot(
  overrides: Partial<LinkVerificationSnapshot> = {},
): LinkVerificationSnapshot {
  return {
    id: 11,
    gameId: 7,
    url: EXACT_URL,
    updatedAt: new Date("2026-09-04T01:00:00.000Z"),
    verificationStatus: "verified",
    verificationMethod: "http",
    httpStatus: 200,
    redirectUrl: "https://old.example.com/final",
    verifiedAt: HISTORICAL_VERIFIED_AT,
    lastCheckedAt: SNAPSHOT_CHECKED_AT,
    ...overrides,
  };
}

function result(
  source: LinkVerificationSnapshot,
  overrides: Partial<LinkVerificationResult> = {},
): LinkVerificationResult {
  return {
    linkId: source.id,
    gameId: source.gameId,
    originalUrl: source.url,
    classification: "verified",
    code: "http_result",
    attempts: [],
    redirectChain: [],
    finalUrl: source.url,
    httpStatus: 204,
    checkedAt: RESULT_CHECKED_AT,
    ...overrides,
  };
}

function plan(
  snapshots: LinkVerificationSnapshot[],
  results: LinkVerificationResult[],
  dryRun = true,
) {
  return planGameLinkVerification({
    gameId: 7,
    dryRun,
    snapshots,
    results,
    now: PLAN_UPDATED_AT,
  });
}

describe("planGameLinkVerification ownership", () => {
  it("keeps a manual runtime result while preserving every manual metadata field", () => {
    const manual = snapshot({
      verificationMethod: "manual",
      verificationStatus: "verified",
      httpStatus: 201,
      redirectUrl: "https://manual.example.com/final",
    });
    const runtimeResult = result(manual, {
      classification: "broken",
      httpStatus: 410,
      finalUrl: null,
    });
    const originalSnapshot = { ...manual };

    const planned = plan([manual], [runtimeResult], false);

    expect(planned).toEqual({
      gameId: 7,
      dryRun: false,
      linksRead: 1,
      verificationResults: [runtimeResult],
      items: [
        {
          action: "skip",
          linkId: 11,
          originalUrl: EXACT_URL,
          reason: "manual_verification_preserved",
        },
      ],
    });
    expect(manual).toEqual(originalSnapshot);
  });

  it.each(["provider_api", "http", null] as const)(
    "maps a redirected verified result for a %s-owned snapshot to exact metadata-only changes",
    (verificationMethod) => {
      const source = snapshot({ verificationMethod });
      const finalUrl = "https://cdn.example.net/final?signature=internal-secret";
      const runtimeResult = result(source, {
        redirectChain: [
          {
            fromUrl: EXACT_URL,
            status: 302,
            location: finalUrl,
            resolvedUrl: finalUrl,
          },
        ],
        finalUrl,
      });

      const planned = plan([source], [runtimeResult]);

      expect(planned.items).toEqual([
        {
          action: "update",
          snapshot: source,
          changes: {
            verificationStatus: "verified",
            verificationMethod: "http",
            httpStatus: 204,
            redirectUrl: finalUrl,
            verifiedAt: RESULT_CHECKED_AT,
            lastCheckedAt: RESULT_CHECKED_AT,
            updatedAt: PLAN_UPDATED_AT,
          },
        },
      ]);
      const item = planned.items[0];
      expect(item?.action).toBe("update");
      if (item?.action !== "update") throw new Error("Expected update plan item");
      expect(Object.keys(item.snapshot).sort()).toEqual([
        "gameId",
        "httpStatus",
        "id",
        "lastCheckedAt",
        "redirectUrl",
        "updatedAt",
        "url",
        "verificationMethod",
        "verificationStatus",
        "verifiedAt",
      ]);
      expect(Object.keys(item.changes).sort()).toEqual([
        "httpStatus",
        "lastCheckedAt",
        "redirectUrl",
        "updatedAt",
        "verificationMethod",
        "verificationStatus",
        "verifiedAt",
      ]);
      expect(JSON.stringify(item.changes)).not.toMatch(
        /"(?:url|provider|platform|linkType|region|isOfficial)":/,
      );
    },
  );

  it("stores no redirect URL for a direct terminal response", () => {
    const source = snapshot({ verificationMethod: null, redirectUrl: null });
    const runtimeResult = result(source, { finalUrl: EXACT_URL });

    const planned = plan([source], [runtimeResult]);

    expect(planned.items[0]).toMatchObject({
      action: "update",
      changes: { redirectUrl: null },
    });
  });

  it.each([
    ["reachable_but_unverified", "http_result", 403],
    ["broken", "invalid_redirect", 302],
    ["temporarily_unavailable", "timeout", null],
    ["unsafe", "unsafe_destination", null],
    ["unknown", "network_error", null],
  ] as const)(
    "preserves historical verification time for %s",
    (classification, code, httpStatus) => {
      const source = snapshot();
      const runtimeResult = result(source, {
        classification,
        code,
        httpStatus,
        finalUrl: null,
        redirectChain: code === "invalid_redirect"
          ? [{ fromUrl: EXACT_URL, status: 302, location: "/bad", resolvedUrl: null }]
          : [],
      });

      const planned = plan([source], [runtimeResult]);

      expect(planned.items[0]).toMatchObject({
        action: "update",
        changes: {
          verificationStatus: classification,
          verificationMethod: "http",
          httpStatus,
          redirectUrl: null,
          verifiedAt: HISTORICAL_VERIFIED_AT,
          lastCheckedAt: RESULT_CHECKED_AT,
          updatedAt: PLAN_UPDATED_AT,
        },
      });
    },
  );

  it("skips when all verification metadata is intentionally unchanged", () => {
    const source = snapshot({
      verificationStatus: "verified",
      verificationMethod: "http",
      httpStatus: 204,
      redirectUrl: null,
      verifiedAt: RESULT_CHECKED_AT,
      lastCheckedAt: RESULT_CHECKED_AT,
    });
    const runtimeResult = result(source);

    expect(plan([source], [runtimeResult]).items).toEqual([
      {
        action: "skip",
        linkId: 11,
        originalUrl: EXACT_URL,
        reason: "no_metadata_change",
      },
    ]);
  });

  it("does not enforce the service-owned 20-link guard", () => {
    const snapshots = Array.from({ length: 21 }, (_, index) => snapshot({ id: index + 1 }));
    const results = snapshots.map((source) => result(source));

    const planned = plan(snapshots, results);

    expect(planned.linksRead).toBe(21);
    expect(planned.items).toHaveLength(21);
  });

  it.each([
    ["broken", "invalid_redirect"],
    ["unsafe", "unsafe_destination"],
  ] as const satisfies readonly [VerificationClassification, VerificationCode][])(
    "does not retain an unresolved %s redirect target",
    (classification, code) => {
      const source = snapshot();
      const runtimeResult = result(source, {
        classification,
        code,
        redirectChain: [
          {
            fromUrl: EXACT_URL,
            status: 302,
            location: "http://unsafe.internal/secret",
            resolvedUrl: null,
          },
        ],
        finalUrl: null,
        httpStatus: 302,
      });

      expect(plan([source], [runtimeResult]).items[0]).toMatchObject({
        action: "update",
        changes: { redirectUrl: null },
      });
    },
  );
});

describe("planGameLinkVerification invariants", () => {
  it("rejects a result for a different exact URL without leaking either URL", () => {
    const source = snapshot();
    const mismatched = result(source, {
      originalUrl: "https://other.example.com/?token=mismatch-secret",
    });

    expect(() => plan([source], [mismatched])).toThrow(
      "Link verification plan invariant violated",
    );
    try {
      plan([source], [mismatched]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("exact-secret");
      expect(message).not.toContain("mismatch-secret");
    }
  });
});
