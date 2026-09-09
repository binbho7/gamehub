import { describe, expect, it, vi } from "vitest";
import type { ImageIngestRepository, ImageIngestSnapshot } from "../../lib/db/repositories/image-ingest";
import { resolveImageCandidates } from "../../lib/images/candidates";
import { downloadImageSource } from "../../lib/images/downloader";
import { validateImageBytes } from "../../lib/images/formats";
import { createImageIngestService } from "../../lib/images/service";
import { presentImageResult } from "../../lib/images/presentation";
import { planImageIngest } from "../../lib/images/plan";
import { validateImageSource } from "../../lib/images/source-policy";
import type { ImageCandidate } from "../../lib/images/candidates";
import type { ImageIngestDependencies, ImageResult } from "../../lib/images/types";

const SOURCE = "https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg";
const SECOND_SOURCE = "https://cdn.akamai.steamstatic.com/steam/apps/10/second.jpg";
const BYTES = new Uint8Array([1, 2, 3]);
const HASH = "a".repeat(64);
const MAX_BYTES = 8_388_608;

function response(status: number, headers: Record<string, string> = {}, body: BodyInit | null = null): Response {
  return new Response(body, { status, headers });
}

function candidate(sourceUrl = SOURCE): ImageCandidate {
  return {
    gameId: 10,
    type: "cover",
    sourceUrl,
    provider: "steam",
    width: null,
    height: null,
    sortOrder: 0,
    existingId: 11,
  };
}

function imageRow(overrides: Partial<ImageIngestSnapshot["images"][number]> = {}): ImageIngestSnapshot["images"][number] {
  return {
    id: 11,
    gameId: 10,
    type: "cover",
    sourceUrl: SOURCE,
    sourceProvider: "steam",
    storageUrl: null,
    storageKey: null,
    contentHash: null,
    mimeType: null,
    fileSize: null,
    width: null,
    height: null,
    sortOrder: 0,
    createdAt: new Date(1),
    updatedAt: new Date(1),
    ...overrides,
  };
}

function snapshot(images: ImageIngestSnapshot["images"] = [imageRow()]): ImageIngestSnapshot {
  return {
    game: { id: 10, coverUrl: SOURCE, heroUrl: null, updatedAt: new Date(1000) },
    images,
  };
}

function repository(current: ImageIngestSnapshot | null, overrides: Partial<ImageIngestRepository> = {}): ImageIngestRepository {
  return {
    readImageIngestSnapshot: vi.fn(async () => current),
    findImageByIdentity: vi.fn(async () => null),
    findImagesByIdentity: vi.fn(async () => []),
    conditionallyCreateImage: vi.fn(async () => "created" as const),
    optimisticBindImage: vi.fn(async () => "applied" as const),
    ...overrides,
  };
}

function r2(overrides: Partial<ImageIngestDependencies["r2"]> = {}): ImageIngestDependencies["r2"] {
  return {
    head: vi.fn(async () => ({ exists: false as const })),
    ensureObject: vi.fn(async ({ key }: { key: string }) => ({
      outcome: "created" as const,
      storageKey: key,
      storageUrl: `https://images.example.test/${key}`,
    })),
    ...overrides,
  };
}

function serviceDependencies(repo: ImageIngestRepository, storage = r2(), overrides: Partial<ImageIngestDependencies> = {}): ImageIngestDependencies {
  return {
    repository: repo,
    r2: storage,
    validate: () => ({ ok: true, mimeType: "image/jpeg", dimensions: { width: 640, height: 360 } }),
    hash: async () => HASH,
    storageKey: () => `images/sha256/aa/aa/${HASH}.jpg`,
    download: vi.fn(async () => ({
      outcome: "downloaded" as const,
      attempts: [],
      finalUrl: SOURCE,
      httpStatus: 200,
      contentType: "image/jpeg",
      bytes: BYTES,
      errorCode: null,
    })),
    now: () => 1000,
    ...overrides,
  };
}

describe("V2.6 image security review", () => {
  it("rejects arbitrary hosts, credentials, fragments, malformed and overlong source URLs", () => {
    const cases = [
      ["https://evil.example.test/image.jpg", "unknown_host"],
      ["https://user:pass@cdn.akamai.steamstatic.com/steam/apps/10/header.jpg", "credentials"],
      ["https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg#secret", "fragment"],
      ["not a URL", "malformed_url"],
      [`https://cdn.akamai.steamstatic.com/${"a".repeat(2_014)}`, "too_long"],
    ] as const;
    for (const [url, reason] of cases) expect(validateImageSource(url, "steam")).toEqual({ ok: false, reason });
  });

  it("fails closed for unknown provider rows and enforces the 128-image game limit", () => {
    const rows = Array.from({ length: 129 }, (_, id) => imageRow({
      id: id + 1,
      sourceUrl: `https://cdn.akamai.steamstatic.com/steam/apps/10/${id}.jpg`,
    }));
    expect(resolveImageCandidates({ game: { id: 10, coverUrl: null, heroUrl: null }, images: rows }).preflight)
      .toBe("image_limit_exceeded");
    const unknown = resolveImageCandidates({
      game: { id: 10, coverUrl: null, heroUrl: null },
      images: [{ id: 11, gameId: 10, type: "cover", sourceUrl: SOURCE, sourceProvider: "other", width: null, height: null, sortOrder: 0 }],
    });
    expect(unknown.candidates).toEqual([]);
    expect(unknown.rejected).toEqual([{ existingId: 11, sourceUrl: SOURCE, outcome: "source_rejected" }]);
  });

  it.each([
    ["cross-provider", "https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg"],
    ["HTTPS downgrade", "http://cdn.akamai.steamstatic.com/steam/apps/10/final.jpg"],
  ])("rejects %s redirects before a second request", async (_label, location) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(302, { Location: location }));
    await expect(downloadImageSource({
      candidate: candidate(), fetchImpl, signal: new AbortController().signal, now: () => 0,
    })).resolves.toMatchObject({ outcome: "redirect_rejected", errorCode: "target_rejected" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("bounds redirects, rejects loops and never follows non-redirect 3xx", async () => {
    const loopFetch = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(302, { Location: SECOND_SOURCE }))
      .mockResolvedValueOnce(response(302, { Location: SOURCE }));
    await expect(downloadImageSource({ candidate: candidate(), fetchImpl: loopFetch, signal: new AbortController().signal, now: () => 0 }))
      .resolves.toMatchObject({ outcome: "redirect_rejected", errorCode: "redirect_loop" });
    const other3xx = vi.fn<typeof fetch>().mockResolvedValue(response(304, { "Content-Type": "text/plain" }));
    await expect(downloadImageSource({ candidate: candidate(), fetchImpl: other3xx, signal: new AbortController().signal, now: () => 0 }))
      .resolves.toMatchObject({ outcome: "download_failed", httpStatus: 304 });
    expect(other3xx).toHaveBeenCalledOnce();
  });

  it("enforces Content-Length and streaming body caps before accepting bytes", async () => {
    const contentLengthFetch = vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      "Content-Length": String(MAX_BYTES + 1),
      "Content-Type": "image/jpeg",
    }));
    await expect(downloadImageSource({ candidate: candidate(), fetchImpl: contentLengthFetch, signal: new AbortController().signal, now: () => 0 }))
      .resolves.toMatchObject({ outcome: "too_large", errorCode: "content_length", bytes: null });

    const streamingFetch = vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      "Content-Type": "image/jpeg",
    }, new Blob([new Uint8Array(MAX_BYTES), new Uint8Array([1])])))
    await expect(downloadImageSource({ candidate: candidate(), fetchImpl: streamingFetch, signal: new AbortController().signal, now: () => 0 }))
      .resolves.toMatchObject({ outcome: "too_large", errorCode: "body_size", bytes: null });
  });

  it("requires MIME and magic agreement and rejects parser-boundary truncation", () => {
    expect(validateImageBytes(new Uint8Array([0xff, 0xd8, 0xff]), "image/png")).toEqual({ ok: false, outcome: "mime_mismatch" });
    expect(validateImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00]), "image/jpeg")).toEqual({ ok: false, outcome: "invalid_image" });
    expect(validateImageBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"))
      .toEqual({ ok: false, outcome: "invalid_image" });
    expect(validateImageBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]), "image/webp"))
      .toEqual({ ok: false, outcome: "invalid_image" });
  });

  it("does not overwrite an existing conflicting R2 object", async () => {
    const complete = imageRow({
      storageUrl: "https://images.example.test/key",
      storageKey: "key",
      contentHash: HASH,
      mimeType: "image/jpeg",
      fileSize: BYTES.byteLength,
      width: 640,
      height: 360,
    });
    const storage = r2({
      head: vi.fn(async () => ({ exists: true as const, size: 99, hash: "b".repeat(64), sha256Metadata: "b".repeat(64), mimeType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" })),
    });
    const repo = repository(snapshot([complete]));
    const result = await createImageIngestService(serviceDependencies(repo, storage)).ingest(10, { write: true });
    expect(result.images).toEqual([{ imageId: 11, outcome: "storage_conflict" }]);
    expect(storage.ensureObject).not.toHaveBeenCalled();
  });

  it("preserves R2-first ordering and isolates stale or partial D1 state", async () => {
    const events: string[] = [];
    const storage = r2({ ensureObject: vi.fn(async ({ key }: { key: string }) => {
      events.push("r2");
      return { outcome: "created" as const, storageKey: key, storageUrl: `https://images.example.test/${key}` };
    }) });
    const staleRepo = repository(snapshot(), { optimisticBindImage: vi.fn(async () => { events.push("d1"); return "write_conflict" as const; }) });
    const stale = await createImageIngestService(serviceDependencies(staleRepo, storage)).ingest(10, { write: true });
    expect(stale.images).toEqual([{ imageId: 11, outcome: "write_conflict" }]);
    expect(events).toEqual(["r2", "d1"]);

    const partialRepo = repository(snapshot([imageRow({ storageUrl: "https://images.example.test/orphan" })]));
    const partialStorage = r2();
    const partial = await createImageIngestService(serviceDependencies(partialRepo, partialStorage)).ingest(10, { write: true });
    expect(partial.images).toEqual([{ imageId: 11, outcome: "inconsistent_state" }]);
    expect(partialStorage.head).not.toHaveBeenCalled();
  });

  it("keeps dry-run read-only and does not persist source changes during restore", async () => {
    const repo = repository(snapshot());
    const storage = r2();
    const dryRun = await createImageIngestService(serviceDependencies(repo, storage)).ingest(10, { write: false });
    expect(dryRun.images).toEqual([{ imageId: 11, outcome: "ingested" }]);
    expect(storage.ensureObject).not.toHaveBeenCalled();
    expect(repo.optimisticBindImage).not.toHaveBeenCalled();

    const complete = imageRow({ storageUrl: "https://images.example.test/key", storageKey: "key", contentHash: HASH, mimeType: "image/jpeg", fileSize: BYTES.byteLength, width: 640, height: 360 });
    const changedRepo = repository(snapshot([complete]));
    const changed = await createImageIngestService(serviceDependencies(changedRepo, r2(), { hash: async () => "b".repeat(64) })).ingest(10, { write: true });
    expect(changed.images).toEqual([{ imageId: 11, outcome: "source_changed" }]);
  });

  it("sanitizes secrets in every presentation URL field and nested attempt", () => {
    const secret = "do-not-leak-token";
    const runtime = {
      gameId: 10,
      status: "partial" as const,
      preflightError: null,
      images: [{
        imageId: 11,
        outcome: "download_failed" as const,
        sourceUrl: `https://cdn.akamai.steamstatic.com/image.jpg?token=${secret}&safe=1`,
        finalUrl: `https://cdn.akamai.steamstatic.com/final.jpg?signature=${secret}`,
        attempts: [{ url: `https://cdn.akamai.steamstatic.com/a.jpg?auth=${secret}`, location: `/b.jpg?api_key=${secret}` }],
        error: { message: `failed at https://cdn.akamai.steamstatic.com/error?secret=${secret}`, url: `https://cdn.akamai.steamstatic.com/error?secret=${secret}` },
      }],
    };
    const presented = presentImageResult(runtime as ImageResult);
    const output = JSON.stringify(presented);
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("#");
  });

  it("does not generate a write plan for a missing game", () => {
    expect(planImageIngest(null, false)).toEqual({ gameId: 0, candidates: [], preflight: "game_not_found", dryRun: false });
  });
});
