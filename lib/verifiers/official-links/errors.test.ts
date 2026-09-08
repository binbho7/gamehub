import { describe, expect, it } from "vitest";
import { LinkVerificationError, type LinkVerificationOperationCode } from "./errors";

const operationCodes = [
  "invalid_game_id",
  "game_not_found",
  "link_limit_exceeded",
  "database_unavailable",
  "local_platform_unavailable",
  "write_failed",
  "cleanup_failed",
  "unexpected_error",
] as const satisfies readonly LinkVerificationOperationCode[];

describe("LinkVerificationError", () => {
  it.each(operationCodes)("serializes only a safe contract for %s", (code) => {
    const operationalCause = {
      rawError: new Error("raw-error-detail"),
      socket: { remoteAddress: "203.0.113.8", authorization: "socket-detail" },
      dnsResponse: { answers: ["dns-response-detail"] },
      httpResponse: { body: "http-response-detail" },
      d1Detail: "d1-detail",
    };
    const error = new LinkVerificationError(code, "Verification operation failed", {
      cause: operationalCause,
    });

    expect(error.toJSON()).toEqual({
      name: "LinkVerificationError",
      code,
      message: "Verification operation failed",
    });

    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain("raw-error-detail");
    expect(serialized).not.toContain("socket-detail");
    expect(serialized).not.toContain("dns-response-detail");
    expect(serialized).not.toContain("http-response-detail");
    expect(serialized).not.toContain("d1-detail");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("cause");
  });
});
