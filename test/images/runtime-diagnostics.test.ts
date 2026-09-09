import { describe, expect, it, vi } from "vitest";
import { createImageIngestService } from "../../lib/images/service";
import { createR2ImageStore } from "../../lib/images/r2-store";
import type { ImageIngestSnapshot, WorkerEnv } from "../../lib/images/types";
import { handleImageIngest } from "../../workers/image-ingest/src/index";
import { runImageIngestCli } from "../../scripts/ingest-images";

const SOURCE = "https://cdn.akamai.steamstatic.com/original.jpg?token=original-secret";
const FINAL = "https://cdn.akamai.steamstatic.com/final.jpg?signature=redirect-secret";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 32, 0, 48, 3, 1, 17, 0, 2, 17, 1, 3, 17, 1, 0xff, 0xd9]);
const snapshot: ImageIngestSnapshot = {
  game: { id: 1, coverUrl: SOURCE, heroUrl: null, updatedAt: new Date(1) },
  images: [],
};

function fixture(contentType = "image/jpeg") {
  const bind = vi.fn(async () => "applied" as const);
  const insert = vi.fn(async () => "created" as const);
  const put = vi.fn(async () => null);
  const sourceFetch: typeof fetch = async (url) => String(url) === SOURCE
    ? new Response(null, { status: 302, headers: { location: FINAL } })
    : new Response(JPEG, { headers: { "content-type": contentType, "content-length": String(JPEG.length) } });
  const service = createImageIngestService({
    repository: { readImageIngestSnapshot: async () => snapshot, findImageByIdentity: async () => null, conditionallyCreateImage: insert, optimisticBindImage: bind },
    r2: createR2ImageStore({ head: async () => null, put } as unknown as WorkerEnv["IMAGES_BUCKET"], "https://images.test"),
    fetchImpl: sourceFetch,
  });
  const env = { DB: {}, IMAGES_BUCKET: {}, IMAGE_PUBLIC_BASE_URL: "https://images.test", IMAGE_INGEST_TOKEN: "worker-secret" } as unknown as WorkerEnv;
  const workerFetch: typeof fetch = (url, init) => handleImageIngest(new Request(String(url), init), env, {} as ExecutionContext, { serviceFactory: () => service });
  return { service, workerFetch, put, bind, insert };
}

describe("real image diagnostics across service, Worker and CLI", () => {
  it("retains source identity, planning reasons, redirect/header/validation/hash/timing diagnostics internally", async () => {
    const { service, put, bind, insert } = fixture();
    const result = await service.ingest(1, { write: false });
    expect(result).toMatchObject({
      plan: { gameSnapshot: { id: 1, coverUrl: SOURCE }, dryRun: true, candidates: [{ sourceUrl: SOURCE, mode: "read_only", reason: "create_missing_scalar" }] },
      images: [{ imageId: null, outcome: "ingested", sourceUrl: SOURCE, provider: "steam", finalUrl: FINAL, httpStatus: 200,
        selectedMimeType: "image/jpeg", byteCount: JPEG.length, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), dimensions: { width: 48, height: 32 },
        error: null, timing: { startedAt: expect.any(Number), finishedAt: expect.any(Number), durationMs: expect.any(Number) },
        redirectChain: [{ fromUrl: SOURCE, location: FINAL, resolvedUrl: FINAL, status: 302 }],
        attempts: [
          { url: SOURCE, provider: "steam", method: "GET", status: 302, hopStatus: "redirect", location: FINAL, presentationUrl: expect.stringContaining("[REDACTED]") },
          { url: FINAL, status: 200, hopStatus: "response", headers: { contentType: "image/jpeg", contentLength: String(JPEG.length) }, selectedMimeType: "image/jpeg", dimensions: { width: 48, height: 32 }, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
      }],
    });
    expect(put).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([true, false])("passes real diagnostics through Worker and CLI (json=%s) without URL secrets", async (json) => {
    const { workerFetch } = fixture();
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runImageIngestCli({ gameId: 1, write: false, json, workerUrl: "http://localhost/internal/images/ingest", token: "worker-secret" }, workerFetch);
      const output = String(stdout.mock.calls[0]?.[0]);
      for (const secret of ["original-secret", "redirect-secret", "worker-secret"]) expect(output).not.toContain(secret);
      for (const field of ['"attempts"', '"redirectChain"', '"dimensions"', '"contentHash"', '"timing"', '"plan"']) expect(output).toContain(field);
      expect(output).toContain("[REDACTED]");
    } finally { stdout.mockRestore(); }
  });

  it("preserves the exact failing stage and transport details for validation failure", async () => {
    const { service } = fixture("image/png");
    const result = await service.ingest(1, { write: false });
    expect(result.images[0]).toMatchObject({
      sourceUrl: SOURCE, outcome: "mime_mismatch", finalUrl: FINAL, httpStatus: 200,
      error: { stage: "validation", code: "mime_mismatch" },
      attempts: [{ status: 302 }, { status: 200, errorCode: "mime_mismatch" }],
    });
  });
});
