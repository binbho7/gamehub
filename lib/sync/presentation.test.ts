import { describe, expect, it } from "vitest";
import type { BulkGameSyncResult } from "./types";
import { formatBulkSyncResultHuman, formatBulkSyncResultJson } from "./presentation";

describe("bulk sync presentation", () => {
  it("sanitizes nested summaries and error URLs without mutating exact input", () => {
    const url = "https://user:password@example.com/a?ToKeN=source-secret#fragment-secret";
    const result: BulkGameSyncResult = {
      dryRun: true, total: 1, succeeded: 0, failed: 1,
      games: [{ appId: "10", gameId: 41, status: "failed", stages: [{
        name: "images", status: "failed", summary: `Request ${url}`,
        error: { code: "worker_invalid_response", message: `Response ${url}` },
      }] }],
    };
    const original = JSON.stringify(result);
    for (const output of [formatBulkSyncResultJson(result), formatBulkSyncResultHuman(result)]) {
      for (const secret of ["source-secret", "password", "fragment-secret"]) expect(output).not.toContain(secret);
      expect(output).toContain("[REDACTED]");
    }
    expect(JSON.stringify(result)).toBe(original);
  });

  it("uses the approved sentinel for a malformed URL", () => {
    const result: BulkGameSyncResult = {
      dryRun: true, total: 1, succeeded: 0, failed: 1,
      games: [{ appId: "10", gameId: 41, status: "failed", stages: [{
        name: "images", status: "failed", summary: "Request https://?token=secret",
        error: { code: "worker_invalid_response", message: "Response https://?token=secret" },
      }] }],
    };
    expect(formatBulkSyncResultJson(result)).toContain("[INVALID_URL]");
    expect(formatBulkSyncResultHuman(result)).toContain("[INVALID_URL]");
  });

  it.each(["token", "access_token", "auth", "authorization", "key", "api_key", "apikey", "signature", "sig", "secret", "credential", "x-amz-signature", "x-amz-credential"])(
    "redacts the %s query key case-insensitively",
    (key) => {
      const result: BulkGameSyncResult = { dryRun: true, total: 1, succeeded: 0, failed: 1, games: [{
        appId: "10", gameId: null, status: "failed", stages: [{ name: "steam", status: "failed",
          summary: `https://example.test/?${key.toUpperCase()}=leak`,
          error: { code: "network_error", message: "Bulk sync steam stage failed (network_error)." } }],
      }] };
      expect(formatBulkSyncResultJson(result)).not.toContain("leak");
    },
  );
});
