/// <reference types="@cloudflare/workers-types" />

export type R2MetadataResult =
  | { exists: false }
  | {
      exists: true;
      size: number;
      hash: string | null;
      mimeType: string | null;
      cacheControl: string | null;
      sha256Metadata: string | null;
    };

export type R2EnsureResult = {
  outcome: "deduplicated" | "concurrent_dedup" | "created" | "storage_conflict" | "storage_failed";
  storageKey: string;
  storageUrl: string;
};

export type R2ImageStore = {
  head(key: string): Promise<R2MetadataResult>;
  ensureObject(input: { key: string; bytes: Uint8Array; hash: string; mimeType: string; size: number }): Promise<R2EnsureResult>;
};

const CACHE_CONTROL = "public, max-age=31536000, immutable";

type ComparableMetadata = Extract<R2MetadataResult, { exists: true }> & { sizeMetadata: string | null };

function bytesToHex(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let result = "";
  for (const byte of view) result += byte.toString(16).padStart(2, "0");
  return result;
}

function checksumToHex(checksum: ArrayBuffer | ArrayBufferView | undefined): string | null {
  return checksum === undefined ? null : bytesToHex(checksum);
}

function storageUrl(publicBaseUrl: string, key: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/${key}`;
}

function comparableMetadata(object: R2Object): ComparableMetadata {
  return {
    exists: true,
    size: object.size,
    hash: checksumToHex(object.checksums.sha256),
    mimeType: object.httpMetadata?.contentType ?? null,
    cacheControl: object.httpMetadata?.cacheControl ?? null,
    sha256Metadata: object.customMetadata?.sha256 ?? null,
    sizeMetadata: object.customMetadata?.size ?? null,
  };
}

function publicMetadata(metadata: ComparableMetadata): R2MetadataResult {
  const { sizeMetadata: _sizeMetadata, ...result } = metadata;
  return result;
}

function matches(metadata: ComparableMetadata, input: { hash: string; mimeType: string; size: number }): boolean {
  return (
    metadata.size === input.size
    && metadata.hash === input.hash
    && metadata.mimeType === input.mimeType
    && metadata.cacheControl === CACHE_CONTROL
    && metadata.sha256Metadata === input.hash
    && metadata.sizeMetadata === String(input.size)
  );
}

export function createR2ImageStore(bucket: R2Bucket, publicBaseUrl: string): R2ImageStore {
  async function read(key: string): Promise<ComparableMetadata | null> {
    const object = await bucket.head(key);
    return object === null ? null : comparableMetadata(object);
  }

  async function head(key: string): Promise<R2MetadataResult> {
    const metadata = await read(key);
    return metadata === null ? { exists: false } : publicMetadata(metadata);
  }

  async function ensureObject(input: { key: string; bytes: Uint8Array; hash: string; mimeType: string; size: number }): Promise<R2EnsureResult> {
    const resultBase = { storageKey: input.key, storageUrl: storageUrl(publicBaseUrl, input.key) };
    let existing: ComparableMetadata | null;
    try {
      existing = await read(input.key);
    } catch {
      return { outcome: "storage_failed", ...resultBase };
    }

    if (existing !== null) {
      return { outcome: matches(existing, input) ? "deduplicated" : "storage_conflict", ...resultBase };
    }

    try {
      const created = await bucket.put(input.key, input.bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: input.hash,
        httpMetadata: { contentType: input.mimeType, cacheControl: CACHE_CONTROL },
        customMetadata: { sha256: input.hash, size: String(input.size) },
      });
      if (created !== null) return { outcome: "created", ...resultBase };
    } catch {
      return { outcome: "storage_failed", ...resultBase };
    }

    let winner: ComparableMetadata | null;
    try {
      winner = await read(input.key);
    } catch {
      return { outcome: "storage_conflict", ...resultBase };
    }
    return { outcome: winner !== null && matches(winner, input) ? "concurrent_dedup" : "storage_conflict", ...resultBase };
  }

  return { head, ensureObject };
}
