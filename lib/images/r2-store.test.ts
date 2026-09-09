/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it } from "vitest";
import { createR2ImageStore, type R2MetadataResult } from "./r2-store";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MIME = "image/png";
const SIZE = 4;
const KEY = `images/sha256/01/23/${HASH}.png`;
const PUBLIC_URL = "https://cdn.example.test/assets";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const BYTES = new Uint8Array([1, 2, 3, 4]);

type PutOptions = Record<string, unknown>;

type FakeObject = {
  key: string;
  version: string;
  size: number;
  etag: string;
  httpEtag: string;
  checksums: { sha256?: ArrayBuffer; toJSON(): Record<string, string> };
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
  writeHttpMetadata(headers: Headers): void;
};

function checksum(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
  return bytes.buffer;
}

function objectFor(overrides: Partial<FakeObject> = {}): FakeObject {
  return {
    key: KEY,
    version: "version-1",
    size: SIZE,
    etag: "etag-1",
    httpEtag: '"etag-1"',
    checksums: { sha256: checksum(HASH), toJSON: () => ({ sha256: HASH }) },
    httpMetadata: { contentType: MIME, cacheControl: CACHE_CONTROL },
    customMetadata: { sha256: HASH, size: String(SIZE) },
    writeHttpMetadata: () => undefined,
    ...overrides,
  };
}

class FakeBucket {
  readonly headCalls: string[] = [];
  readonly putCalls: Array<{ key: string; bytes: Uint8Array; options?: PutOptions }> = [];
  private readonly heads: Array<FakeObject | null>;
  private readonly headErrors: Array<Error | null>;
  private readonly putResult: FakeObject | null;
  private readonly putError: Error | null;

  constructor({ heads, headErrors = [], putResult = objectFor(), putError = null }: { heads: Array<FakeObject | null>; headErrors?: Array<Error | null>; putResult?: FakeObject | null; putError?: Error | null }) {
    this.heads = [...heads];
    this.headErrors = [...headErrors];
    this.putResult = putResult;
    this.putError = putError;
  }

  async head(key: string): Promise<FakeObject | null> {
    this.headCalls.push(key);
    const error = this.headErrors.shift() ?? null;
    if (error) throw error;
    return this.heads.shift() ?? null;
  }

  async put(key: string, bytes: Uint8Array, options?: PutOptions): Promise<FakeObject | null> {
    this.putCalls.push({ key, bytes, options });
    if (this.putError) throw this.putError;
    return this.putResult;
  }
}

function input() {
  return { key: KEY, bytes: BYTES, hash: HASH, mimeType: MIME, size: SIZE };
}

function store(bucket: FakeBucket) {
  return createR2ImageStore(bucket as unknown as R2Bucket, PUBLIC_URL);
}

describe("R2 image store", () => {
  it("reports a missing object from HEAD", async () => {
    const bucket = new FakeBucket({ heads: [null] });

    await expect(store(bucket).head(KEY)).resolves.toEqual({ exists: false } satisfies R2MetadataResult);
    expect(bucket.headCalls).toEqual([KEY]);
  });

  it("returns all comparable metadata for a present object", async () => {
    const bucket = new FakeBucket({ heads: [objectFor()] });

    await expect(store(bucket).head(KEY)).resolves.toEqual({
      exists: true,
      size: SIZE,
      hash: HASH,
      mimeType: MIME,
      cacheControl: CACHE_CONTROL,
      sha256Metadata: HASH,
      sizeMetadata: String(SIZE),
    } satisfies R2MetadataResult);
  });

  it("deduplicates a present object whose metadata exactly matches", async () => {
    const bucket = new FakeBucket({ heads: [objectFor()] });

    await expect(store(bucket).ensureObject(input())).resolves.toEqual({
      outcome: "deduplicated",
      storageKey: KEY,
      storageUrl: `${PUBLIC_URL}/${KEY}`,
    });
    expect(bucket.putCalls).toHaveLength(0);
  });

  it("reports a storage conflict when an existing object differs", async () => {
    const bucket = new FakeBucket({ heads: [objectFor({ size: SIZE + 1 })] });

    await expect(store(bucket).ensureObject(input())).resolves.toEqual({
      outcome: "storage_conflict",
      storageKey: KEY,
      storageUrl: `${PUBLIC_URL}/${KEY}`,
    });
    expect(bucket.putCalls).toHaveLength(0);
  });

  it("conditionally creates a missing object with immutable metadata and checksum", async () => {
    const bucket = new FakeBucket({ heads: [null], putResult: objectFor() });

    await expect(store(bucket).ensureObject(input())).resolves.toEqual({
      outcome: "created",
      storageKey: KEY,
      storageUrl: `${PUBLIC_URL}/${KEY}`,
    });
    expect(bucket.putCalls).toHaveLength(1);
    expect(bucket.putCalls[0]).toMatchObject({ key: KEY, bytes: BYTES });
    expect(bucket.putCalls[0]?.options).toEqual({
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: HASH,
      httpMetadata: { contentType: MIME, cacheControl: CACHE_CONTROL },
      customMetadata: { sha256: HASH, size: String(SIZE) },
    });
    expect(bucket.headCalls).toEqual([KEY]);
  });

  it("re-HEADs after a conditional race and classifies an exact match as concurrent deduplication", async () => {
    const bucket = new FakeBucket({ heads: [null, objectFor()], putResult: null });

    await expect(store(bucket).ensureObject(input())).resolves.toEqual({
      outcome: "concurrent_dedup",
      storageKey: KEY,
      storageUrl: `${PUBLIC_URL}/${KEY}`,
    });
    expect(bucket.headCalls).toEqual([KEY, KEY]);
    expect(bucket.putCalls).toHaveLength(1);
  });

  it("reports a conflict after a conditional race when the winner differs", async () => {
    const bucket = new FakeBucket({ heads: [null, objectFor({ size: SIZE + 1 })], putResult: null });

    await expect(store(bucket).ensureObject(input())).resolves.toEqual({
      outcome: "storage_conflict",
      storageKey: KEY,
      storageUrl: `${PUBLIC_URL}/${KEY}`,
    });
    expect(bucket.headCalls).toEqual([KEY, KEY]);
  });

  it("reports a conflict when the conditional race winner is missing", async () => {
    const bucket = new FakeBucket({ heads: [null, null], putResult: null });

    await expect(store(bucket).ensureObject(input())).resolves.toEqual({
      outcome: "storage_conflict",
      storageKey: KEY,
      storageUrl: `${PUBLIC_URL}/${KEY}`,
    });
  });

  it("maps a re-HEAD operation failure after a conditional race to storage_failed", async () => {
    const bucket = new FakeBucket({ heads: [null], headErrors: [null, new Error("r2 unavailable")], putResult: null });

    await expect(store(bucket).ensureObject(input())).resolves.toEqual({
      outcome: "storage_failed",
      storageKey: KEY,
      storageUrl: `${PUBLIC_URL}/${KEY}`,
    });
    expect(bucket.headCalls).toEqual([KEY, KEY]);
  });

  it("maps an operational PUT failure to storage_failed without retrying or deleting", async () => {
    const bucket = new FakeBucket({ heads: [null], putError: new Error("r2 unavailable") });

    await expect(store(bucket).ensureObject(input())).resolves.toEqual({
      outcome: "storage_failed",
      storageKey: KEY,
      storageUrl: `${PUBLIC_URL}/${KEY}`,
    });
    expect(bucket.headCalls).toEqual([KEY]);
    expect(bucket.putCalls).toHaveLength(1);
  });
});
