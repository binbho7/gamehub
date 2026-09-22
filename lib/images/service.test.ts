import { describe, expect, it, vi } from "vitest";
import type { ImageIngestRepository, ImageIngestSnapshot } from "../db/repositories/image-ingest";
import { createImageIngestService } from "./service";
import type { ImageIngestDependencies } from "./types";
import { createR2ImageStore } from "./r2-store";

const SOURCE = "https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg";
const BYTES = new Uint8Array([1, 2, 3]);
const HASH = "a".repeat(64);

function row(overrides: Partial<ImageIngestSnapshot["images"][number]> = {}): ImageIngestSnapshot["images"][number] {
  return {
    id: 11, gameId: 10, type: "cover", sourceUrl: SOURCE, sourceProvider: "steam",
    storageUrl: null, storageKey: null, contentHash: null, mimeType: null, fileSize: null,
    width: null, height: null, sortOrder: 0, createdAt: new Date(1), updatedAt: new Date(1), ...overrides,
  };
}

function snapshot(images: ImageIngestSnapshot["images"] = [row()]): ImageIngestSnapshot {
  return { game: { id: 10, coverUrl: SOURCE, heroUrl: null, updatedAt: new Date(1000) }, images };
}

function r2(overrides: Partial<NonNullable<ImageIngestDependencies["r2"]>> = {}) {
  return {
    head: vi.fn(async () => ({ exists: false as const })),
    ensureObject: vi.fn(async ({ key }: { key: string }) => ({ outcome: "created" as const, storageKey: key, storageUrl: `https://images.test/${key}` })),
    ...overrides,
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

function deps(repo: ImageIngestRepository, bucket = r2(), overrides: Partial<ImageIngestDependencies> = {}): ImageIngestDependencies {
  return {
    repository: repo,
    r2: bucket,
    now: () => 1000,
    validate: () => ({ ok: true, mimeType: "image/jpeg", dimensions: { width: 640, height: 360 } }),
    hash: async () => HASH,
    storageKey: () => `images/sha256/aa/aa/${HASH}.jpg`,
    download: vi.fn(async () => ({ outcome: "downloaded" as const, attempts: [], finalUrl: SOURCE, httpStatus: 200, contentType: "image/jpeg", bytes: BYTES, errorCode: null })),
    gameDeadlineMs: 300_000,
    ...overrides,
  };
}

describe("image ingest service", () => {
  it("completes the Batch 001 mixed Steam shared-CDN and IGDB image set", async () => {
    const images = [row(),
      row({ id: 12, type: "screenshot", sourceUrl: "https://shared.akamai.steamstatic.com/steam/apps/1245620/ss.jpg" }),
      row({ id: 13, type: "cover", sourceProvider: "igdb", sourceUrl: "https://images.igdb.com/igdb/image/upload/cover.jpg" }),
      row({ id: 14, type: "artwork", sourceProvider: "igdb", sourceUrl: "https://images.igdb.com/igdb/image/upload/art.jpg" }),
    ];
    const result = await createImageIngestService(deps(repository(snapshot(images)))).ingest(10, { write: true });
    expect(result.status).toBe("completed");
    expect(result.images.map(image => image.outcome)).toEqual(["ingested", "ingested", "ingested", "ingested"]);
  });
  it.each(["resolve", "reject"])("isolates a non-cooperative download deadline and handles its late %s", async (settlement) => {
    vi.useFakeTimers();
    try {
      const images = [row(), row({ id: 12, sourceUrl: SOURCE + "?second" }), row({ id: 13, sourceUrl: SOURCE + "?third" })];
      const repo = repository(snapshot(images));
      let resolveLate!: (value: Awaited<ReturnType<NonNullable<ImageIngestDependencies["download"]>>>) => void;
      let rejectLate!: (error: Error) => void;
      const late = new Promise<Awaited<ReturnType<NonNullable<ImageIngestDependencies["download"]>>>>((resolve, reject) => { resolveLate = resolve; rejectLate = reject; });
      const downloaded = { outcome: "downloaded" as const, attempts: [], finalUrl: SOURCE, httpStatus: 200, contentType: "image/jpeg", bytes: BYTES, errorCode: null };
      let calls = 0;
      const download = async () => ++calls === 2 ? late : downloaded;
      const pending = createImageIngestService(deps(repo, r2(), { now: () => Date.now(), download })).ingest(10, { write: true });
      // Attach before advancing time so rejection is observed as a failed assertion.
      const checked = expect(pending).resolves.toMatchObject({ status: "partial", images: [{ outcome: "ingested" }, { outcome: "deadline" }, { outcome: "ingested" }] });
      await vi.advanceTimersByTimeAsync(30_000);
      await checked;
      if (settlement === "resolve") resolveLate(downloaded); else rejectLate(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(1);
      expect(repo.optimisticBindImage).toHaveBeenCalledTimes(2);
      expect(calls).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it("does not start a delayed real R2 adapter PUT after the service deadline", async () => {
    vi.useFakeTimers();
    try {
      let releaseHead!: (value: null) => void;
      const head = new Promise<null>((resolve) => { releaseHead = resolve; });
      const put = vi.fn(async () => null);
      const bucket = createR2ImageStore({ head: () => head, put } as unknown as Parameters<typeof createR2ImageStore>[0], "https://images.test");
      const repo = repository(snapshot());
      const pending = createImageIngestService({ ...deps(repo), r2: bucket, now: () => Date.now() }).ingest(10, { write: true });
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await pending).images[0]?.outcome).toBe("deadline");
      releaseHead(null);
      await vi.advanceTimersByTimeAsync(1);
      expect(put).not.toHaveBeenCalled();
      expect(repo.optimisticBindImage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it.each([null, "999"])("rejects inconsistent R2 custom size %s in both idempotency and dry-run", async (sizeMetadata) => {
    const head = async () => ({ exists: true as const, size: 3, hash: HASH, sha256Metadata: HASH, sizeMetadata, mimeType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" });
    const complete = row({ storageUrl: "https://images.test/key", storageKey: "key", contentHash: HASH, mimeType: "image/jpeg", fileSize: 3, width: 640, height: 360 });
    for (const current of [row(), complete]) {
      const result = await createImageIngestService(deps(repository(snapshot([current])), r2({ head }))).ingest(10, { write: false });
      expect(result.images[0]?.outcome).toBe("storage_conflict");
    }
  });
  it("ingests a fresh existing row with R2-first then optimistic D1 binding", async () => {
    const repo = repository(snapshot());
    const bucket = r2();
    const result = await createImageIngestService(deps(repo, bucket)).ingest(10, { write: true });
    expect(result).toMatchObject({ gameId: 10, status: "completed", preflightError: null, images: [{ imageId: 11, outcome: "ingested" }] });
    expect(bucket.ensureObject).toHaveBeenCalledOnce();
    expect(repo.optimisticBindImage).toHaveBeenCalledOnce();
  });

  it("does a metadata HEAD only for an already-ingested row", async () => {
    const complete = row({ storageUrl: "https://images.test/key", storageKey: "key", contentHash: HASH, mimeType: "image/jpeg", fileSize: 3, width: 640, height: 360 });
    const bucket = r2({ head: vi.fn(async () => ({ exists: true as const, size: 3, sizeMetadata: "3", hash: HASH, sha256Metadata: HASH, mimeType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" })) });
    const repo = repository(snapshot([complete]));
    const result = await createImageIngestService(deps(repo, bucket)).ingest(10, { write: true });
    expect(result.images).toMatchObject([{ imageId: 11, outcome: "already_ingested" }]);
    expect(bucket.ensureObject).not.toHaveBeenCalled();
  });

  it("dry-run performs real processing and R2 HEAD but no PUT or D1 writes", async () => {
    const repo = repository(snapshot());
    const bucket = r2();
    const result = await createImageIngestService(deps(repo, bucket)).ingest(10, { write: false });
    expect(result.images).toMatchObject([{ imageId: 11, outcome: "ingested" }]);
    expect(bucket.head).toHaveBeenCalledOnce();
    expect(bucket.ensureObject).not.toHaveBeenCalled();
    expect(repo.optimisticBindImage).not.toHaveBeenCalled();
  });

  it("isolates a source failure and continues to the next candidate", async () => {
    const second = row({ id: 12, sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/10/second.jpg", sortOrder: 1 });
    const repo = repository(snapshot([row(), second]));
    const download = vi.fn()
      .mockResolvedValueOnce({ outcome: "download_failed" as const, attempts: [], finalUrl: null, httpStatus: null, contentType: null, bytes: null, errorCode: "network_error" })
      .mockResolvedValueOnce({ outcome: "downloaded" as const, attempts: [], finalUrl: SOURCE, httpStatus: 200, contentType: "image/jpeg", bytes: BYTES, errorCode: null });
    const result = await createImageIngestService(deps(repo, r2(), { download })).ingest(10, { write: true });
    expect(result.status).toBe("partial");
    expect(result.images.map((image) => image.outcome)).toEqual(["download_failed", "ingested"]);
  });

  it("returns game-level failure before any network or mutation above the image limit", async () => {
    const images = Array.from({ length: 129 }, (_, index) => row({ id: index + 1, sourceUrl: `https://cdn.akamai.steamstatic.com/steam/apps/10/${index}.jpg`, sortOrder: index }));
    const repo = repository(snapshot(images));
    const bucket = r2();
    const result = await createImageIngestService(deps(repo, bucket)).ingest(10, { write: true });
    expect(result).toMatchObject({ gameId: 10, status: "failed", preflightError: "image_limit_exceeded", images: [] });
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it("reports a missing game without invoking image operations", async () => {
    const repo = repository(null);
    const bucket = r2();
    await expect(createImageIngestService(deps(repo, bucket)).ingest(10, { write: true })).resolves.toEqual({ gameId: 10, status: "failed", preflightError: "game_not_found", plan: null, images: [] });
  });

  it("restores a complete D1 row when its R2 object is missing and the source hash is unchanged", async () => {
    const complete = row({ storageUrl: "https://images.test/key", storageKey: "key", contentHash: HASH, mimeType: "image/jpeg", fileSize: 3, width: 640, height: 360 });
    const bucket = r2({ ensureObject: vi.fn(async () => ({ outcome: "created" as const, storageKey: "key", storageUrl: "https://images.test/key" })) });
    const repo = repository(snapshot([complete]));
    const result = await createImageIngestService(deps(repo, bucket)).ingest(10, { write: true });
    expect(result.images).toMatchObject([{ imageId: 11, outcome: "restored" }]);
    expect(bucket.ensureObject).toHaveBeenCalledOnce();
    expect(repo.optimisticBindImage).not.toHaveBeenCalled();
  });

  it("does not restore a row when source bytes changed", async () => {
    const complete = row({ storageUrl: "https://images.test/key", storageKey: "key", contentHash: HASH, mimeType: "image/jpeg", fileSize: 3, width: 640, height: 360 });
    const repo = repository(snapshot([complete]));
    const result = await createImageIngestService(deps(repo, r2(), { hash: async () => "b".repeat(64) })).ingest(10, { write: true });
    expect(result.images).toMatchObject([{ imageId: 11, outcome: "source_changed" }]);
  });

  it("isolates partial metadata as inconsistent state without network or storage calls", async () => {
    const partial = row({ storageUrl: "https://images.test/key" });
    const repo = repository(snapshot([partial]));
    const bucket = r2();
    const result = await createImageIngestService(deps(repo, bucket)).ingest(10, { write: true });
    expect(result.images).toMatchObject([{ imageId: 11, outcome: "inconsistent_state" }]);
    expect(bucket.head).not.toHaveBeenCalled();
  });

  it("leaves an R2 orphan and reports D1 failure when binding fails", async () => {
    const repo = repository(snapshot(), {
      optimisticBindImage: vi.fn(async () => { throw new Error("d1 unavailable"); }),
    });
    const bucket = r2();
    const result = await createImageIngestService(deps(repo, bucket)).ingest(10, { write: true });
    expect(result.images).toMatchObject([{ imageId: 11, outcome: "d1_write_failed" }]);
    expect(bucket.ensureObject).toHaveBeenCalledOnce();
  });

  it("rejects a race reread unless exactly one winner matches the intended binding", async () => {
    const winner = row({ id: 21, storageUrl: "https://images.test/images/sha256/aa/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg", storageKey: "images/sha256/aa/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg", contentHash: HASH, mimeType: "image/jpeg", fileSize: 3, width: 640, height: 360 });
    const duplicate = { ...winner, id: 22 };
    const repo = repository(snapshot([]), {
      conditionallyCreateImage: vi.fn(async () => "race" as const),
      findImagesByIdentity: vi.fn(async () => [winner, duplicate]),
    });
    const result = await createImageIngestService(deps(repo)).ingest(10, { write: true });
    expect(result.images).toMatchObject([{ imageId: 21, outcome: "inconsistent_state" }]);
  });

  it("blocks R2 mutation when validation/hash work reaches the image deadline", async () => {
    let current = 1000;
    const bucket = r2();
    const repo = repository(snapshot());
    const result = await createImageIngestService(deps(repo, bucket, {
      now: () => current,
      validate: () => { current = 31_001; return { ok: true, mimeType: "image/jpeg", dimensions: { width: 640, height: 360 } }; },
    })).ingest(10, { write: true });
    expect(result.images).toMatchObject([{ imageId: 11, outcome: "deadline" }]);
    expect(bucket.ensureObject).not.toHaveBeenCalled();
  });

  it("maps an R2 operation that exceeds the hard image deadline to deadline", async () => {
    vi.useFakeTimers();
    try {
      const repo = repository(snapshot());
      const bucket = r2({ ensureObject: vi.fn(async () => await new Promise<never>(() => undefined)) });
      const pending = createImageIngestService(deps(repo, bucket, { now: () => Date.now() })).ingest(10, { write: true });
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await pending).images).toMatchObject([{ imageId: 11, outcome: "deadline", error: { stage: "storage", code: "image_deadline" } }]);
      expect(bucket.ensureObject).toHaveBeenCalledOnce();
      expect(repo.optimisticBindImage).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
