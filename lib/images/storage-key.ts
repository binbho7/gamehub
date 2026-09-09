import type { ImageMimeType } from "./formats";

const HASH_PATTERN = /^[0-9a-f]{64}$/;

const MIME_EXTENSIONS: Record<ImageMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function buildImageStorageKey(hash: string, mimeType: ImageMimeType): string {
  if (!HASH_PATTERN.test(hash)) throw new Error("invalid_image_hash");

  const extension = MIME_EXTENSIONS[mimeType];
  if (extension === undefined) throw new Error("invalid_image_mime");

  return `images/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${extension}`;
}
