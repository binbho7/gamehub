import { describe, expect, it, vi } from "vitest";
import { createScheduledImageClient } from "./scheduled-client";
import { parseScheduledImageRequest, parseScheduledImageResponse } from "./scheduled-codec";
import { createCronSignals } from "../scheduler/signals";
import type { ImageItemResult, ImageResult } from "./types";

const authority = { ownerToken: "22222222-2222-4222-8222-222222222222", fenceEpoch: 1, leaseExpiresAtMs: 9999999999999 };
const requestId = "11111111-1111-4111-8111-111111111111";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function item(outcome: ImageItemResult["outcome"]): ImageItemResult {
  return { imageId: 1, outcome, sourceUrl: "https://example.com/a", presentationUrl: "https://example.com/a", provider: "steam", attempts: [], redirectChain: [], finalUrl: null, httpStatus: null, selectedMimeType: null, byteCount: null, contentHash: null, dimensions: null, timing: { startedAt: 0, finishedAt: 1, durationMs: 1 }, error: null };
}
describe("scheduled image client", () => {
  it.each(["image_deadline", "storage_failed", "d1_write_failed"])("scans nested attempt errors %s", async code => {
    const signals = createCronSignals();
    const entry = item("source_rejected");
    entry.attempts = [{ url: entry.sourceUrl, presentationUrl: entry.presentationUrl, provider: "steam", method: "GET", hopStatus: "failed", status: null, headers: { contentType: null, contentLength: null }, location: null, redirectChain: [], finalUrl: null, selectedMimeType: null, byteCount: null, contentHash: null, dimensions: null, timing: entry.timing, errorCode: code }];
    const client = createScheduledImageClient({ token: "scheduled", authority, signals, newRequestId: () => requestId, binding: { fetch: async () => Response.json({ version: 1, requestId, authorityStatus: "not_observed_lost", result: { gameId: 9, status: "failed", preflightError: null, plan: null, images: [entry] } }) } });
    expect((await client.ingest(9, { write: true })).images).toHaveLength(1);
    expect(signals.readUnsettledImageWork()).toEqual([code === "image_deadline" ? "image_deadline" : "image_mutation_unknown"]);
  });
  it("bounds noncooperative delivery and retains uncertainty after a late response", async () => {
    vi.useFakeTimers();
    try {
      const signals = createCronSignals();
      let resolve!: (response: Response) => void;
      const response = new Promise<Response>(done => { resolve = done; });
      const client = createScheduledImageClient({ token: "scheduled", authority, signals, newRequestId: () => requestId, binding: { fetch: async () => response } });
      const pending = expect(client.ingest(9, { write: true })).rejects.toMatchObject({ code: "worker_network_error" });
      await vi.advanceTimersByTimeAsync(310_000); await pending;
      resolve(Response.json({ version: 1, requestId, authorityStatus: "not_observed_lost", result: { gameId: 9, status: "failed", preflightError: "game_not_found", plan: null, images: [] } }));
      await vi.advanceTimersByTimeAsync(1);
      expect(signals.readUnsettledImageWork()).toEqual(["image_delivery_unknown"]);
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])("scans every native item before returning, reversed=%s", async reverse => {
    const signals = createCronSignals();
    const images = [item("source_rejected"), item("deadline"), item("d1_write_failed")];
    if (reverse) images.reverse();
    const result: ImageResult = { gameId: 9, status: "failed", preflightError: null, plan: null, images };
    const client = createScheduledImageClient({ token: "scheduled", authority, signals, newRequestId: () => requestId, binding: { fetch: async request => {
      expect(new URL(request.url).pathname).toBe("/internal/v1/images/ingest-scheduled");
      expect(request.redirect).toBe("error");
      expect(request.headers.get("authorization")).toBe("Bearer scheduled");
      expect(parseScheduledImageRequest(new Uint8Array(await request.arrayBuffer()))).toEqual({ version: 1, mode: "scheduled", requestId, gameId: 9, write: true, authority });
      return Response.json({ version: 1, requestId, authorityStatus: "fence_lost", result });
    } } });
    expect(await client.ingest(9, { write: true })).toEqual(result);
    expect(signals.readUnsettledImageWork()).toEqual(expect.arrayContaining(["image_deadline", "image_mutation_unknown"]));
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
  });
  it.each(["http", "invalid", "oversized", "missing", "network"])("latches delivery uncertainty for %s", async kind => {
    const signals = createCronSignals();
    const client = createScheduledImageClient({ token: "scheduled", authority, signals, newRequestId: () => requestId, binding: { fetch: async () => {
      if (kind === "network") throw new Error("offline");
      if (kind === "http") return new Response(null, { status: 500 });
      if (kind === "oversized") return new Response(" ".repeat(1024 * 1024 + 1));
      return Response.json(kind === "missing" ? { gameId: 9, status: "completed", plan: null, images: [], preflightError: null } : {});
    } } });
    await expect(client.ingest(9, { write: true })).rejects.toMatchObject({ stage: "images" });
    expect(signals.readUnsettledImageWork()).toEqual(["image_delivery_unknown"]);
  });
  it("rejects read-only calls before dispatch", async () => {
    const fetch = vi.fn();
    const client = createScheduledImageClient({ token: "scheduled", authority, signals: createCronSignals(), newRequestId: () => requestId, binding: { fetch } });
    await expect(client.ingest(9, { write: false })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires matching strict envelopes and freezes authority", () => {
    const request = parseScheduledImageRequest(bytes({ version: 1, mode: "scheduled", requestId, gameId: 9, write: true, authority }));
    expect(Object.isFrozen(request.authority)).toBe(true);
    expect(() => parseScheduledImageResponse(bytes({ version: 1, requestId: crypto.randomUUID(), authorityStatus: "not_observed_lost", result: {} }), request)).toThrow();
    expect(() => parseScheduledImageRequest(new TextEncoder().encode(JSON.stringify(request).replace('"version":1', '"version":1,"version":1')))).toThrow();
  });
});
