import { parseImageDimensions, type ImageDimensions } from "./dimensions";

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";
export type { ImageDimensions } from "./dimensions";

export type ImageValidation =
  | { ok: true; mimeType: ImageMimeType; dimensions: ImageDimensions }
  | { ok: false; outcome: "mime_mismatch" | "invalid_image" };

function hasMagicBytes(bytes: Uint8Array, mimeType: ImageMimeType): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  return (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  );
}

export function validateImageBytes(bytes: Uint8Array, contentType: string | null): ImageValidation {
  const normalized = contentType === null ? null : contentType.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  if (normalized !== "image/jpeg" && normalized !== "image/png" && normalized !== "image/webp") {
    return { ok: false, outcome: "mime_mismatch" };
  }

  const mimeType = normalized as ImageMimeType;
  if (!hasMagicBytes(bytes, mimeType)) return { ok: false, outcome: "mime_mismatch" };

  try {
    return { ok: true, mimeType, dimensions: parseImageDimensions(bytes, mimeType) };
  } catch {
    return { ok: false, outcome: "invalid_image" };
  }
}
