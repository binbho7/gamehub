import { describe, expect, it, vi } from "vitest";
import worker, { type WorkerEnv } from "./index";
import { handleScheduledImageIngest } from "./scheduled";

const env = { DB: {}, IMAGES_BUCKET: {}, IMAGE_PUBLIC_BASE_URL: "https://images.example.test", IMAGE_INGEST_TOKEN: "legacy", IMAGE_INGEST_SCHEDULED_TOKEN: "scheduled" } as unknown as WorkerEnv;
const ctx = {} as ExecutionContext;
const body = { version: 1, mode: "scheduled", requestId: "11111111-1111-4111-8111-111111111111", gameId: 9, write: true, authority: { ownerToken: "22222222-2222-4222-8222-222222222222", fenceEpoch: 1, leaseExpiresAtMs: 9999999999999 } };
const request = (token = "scheduled", payload: unknown = body, path = "/internal/v1/images/ingest-scheduled") => new Request(`https://image.internal${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) });

describe("scheduled image trust boundary", () => {
  it.each([["legacy", "/internal/v1/images/ingest-scheduled"], ["scheduled", "/internal/images/ingest"]])("rejects the other route credential %s", async (token, path) => {
    expect((await worker.fetch(request(token, body, path), env, ctx)).status).toBe(401);
  });
  it("fails closed when route credentials are equal", async () => {
    expect((await worker.fetch(request(), { ...env, IMAGE_INGEST_TOKEN: "scheduled" }, ctx)).status).toBe(500);
  });
  it("rejects scheduled fields on the legacy route", async () => {
    expect((await worker.fetch(request("legacy", body, "/internal/images/ingest"), env, ctx)).status).toBe(400);
  });
  it("bounds the request and requires JSON content type before composition", async () => {
    for (const invalid of [new Request("https://image.internal/internal/v1/images/ingest-scheduled", { method: "POST", headers: { authorization: "Bearer scheduled", "content-type": "text/plain" }, body: JSON.stringify(body) }), request("scheduled", { ...body, extra: "x".repeat(16 * 1024) })]) {
      const serviceFactory = vi.fn();
      expect((await handleScheduledImageIngest(invalid, env, ctx, { serviceFactory })).status).toBe(400);
      expect(serviceFactory).not.toHaveBeenCalled();
    }
  });
  it.each([{ ...body, authority: undefined }, { ...body, write: false }, { ...body, version: 2 }, { ...body, extra: 1 }, { ...body, authority: { ...body.authority, extra: 1 } }])("rejects invalid authority/envelope before composition", async payload => {
    const serviceFactory = vi.fn();
    expect((await handleScheduledImageIngest(request("scheduled", payload), env, ctx, { serviceFactory })).status).toBe(400);
    expect(serviceFactory).not.toHaveBeenCalled();
  });
  it("dispatches the scheduled route and preserves the native result envelope", async () => {
    const result = { gameId: 9, status: "failed", preflightError: "game_not_found", plan: null, images: [] } as const;
    const response = await handleScheduledImageIngest(request(), env, ctx, { serviceFactory: () => ({ ingest: async () => ({ ...result, images: [] }) }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, requestId: body.requestId, authorityStatus: "not_observed_lost", result });
  });
});
