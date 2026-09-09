import type { ImageAttempt, ImageItemResult } from "../../lib/images/types";

export function imageItemFixture(overrides: Partial<ImageItemResult> = {}): ImageItemResult {
  return {
    imageId: 11, outcome: "ingested", sourceUrl: "https://images.igdb.com/a.jpg",
    presentationUrl: "https://images.igdb.com/a.jpg", provider: "igdb", attempts: [], redirectChain: [],
    finalUrl: null, httpStatus: null, selectedMimeType: null, byteCount: null, contentHash: null,
    dimensions: null, error: null, timing: { startedAt: 1, finishedAt: 2, durationMs: 1 }, ...overrides,
  };
}

export function imageAttemptFixture(overrides: Partial<ImageAttempt> = {}): ImageAttempt {
  return {
    url: "https://images.igdb.com/a.jpg", presentationUrl: "https://images.igdb.com/a.jpg", provider: "igdb",
    method: "GET", status: 200, hopStatus: "response", headers: { contentType: "image/jpeg", contentLength: "23" },
    location: null, redirectChain: [], finalUrl: null, selectedMimeType: null, byteCount: null, contentHash: null,
    dimensions: null, timing: { startedAt: 1, finishedAt: 2, durationMs: 1 }, errorCode: null, ...overrides,
  };
}
