import { describe, expect, it } from "vitest";
import { authenticateBearer } from "./auth";

describe("image ingest bearer authentication", () => {
  const expected = "test-secret-token";

  it.each([
    ["missing", undefined],
    ["wrong token", "Bearer wrong"],
    ["wrong scheme", "Basic test-secret-token"],
    ["empty token", "Bearer "],
  ])("rejects %s authorization", async (_label, authorization) => {
    const request = new Request("https://worker.example/internal/images/ingest", {
      headers: authorization === undefined ? undefined : { Authorization: authorization },
    });
    await expect(authenticateBearer(request, expected)).resolves.toBe(false);
  });

  it("accepts the exact bearer token", async () => {
    const request = new Request("https://worker.example/internal/images/ingest", {
      headers: { Authorization: `Bearer ${expected}` },
    });
    await expect(authenticateBearer(request, expected)).resolves.toBe(true);
  });

  it("never treats query or body tokens as credentials", async () => {
    const query = new Request(`https://worker.example/internal/images/ingest?token=${expected}`, { method: "POST" });
    await expect(authenticateBearer(query, expected)).resolves.toBe(false);
    const body = new Request("https://worker.example/internal/images/ingest", {
      method: "POST",
      body: JSON.stringify({ gameId: 1, write: false, token: expected }),
    });
    await expect(authenticateBearer(body, expected)).resolves.toBe(false);
  });

  it("rejects a missing expected secret", async () => {
    const request = new Request("https://worker.example/internal/images/ingest", {
      headers: { Authorization: "Bearer anything" },
    });
    await expect(authenticateBearer(request, "")).resolves.toBe(false);
  });
});
