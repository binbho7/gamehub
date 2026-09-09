import {
  INVALID_URL,
  sanitizeTextForPresentation,
  sanitizeUrlForPresentation,
} from "../verifiers/official-links/presentation";
import type { ImageResult } from "./types";

const URL_FIELD = /(?:^|url|uri|location|redirect|source|original|final|resolved)$/i;

type Presented<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Presented<T[K]> } : T;
export type PresentedImageResult = Presented<ImageResult>;
export type PresentedImage = PresentedImageResult["images"][number];

function sanitizeValue(value: unknown, key: string | null, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return key !== null && URL_FIELD.test(key)
      ? sanitizeUrlForPresentation(value)
      : sanitizeTextForPresentation(value);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: sanitizeTextForPresentation(value.name),
      message: sanitizeTextForPresentation(value.message),
    };
  }
  if (typeof value !== "object") return null;
  if (seen.has(value)) return INVALID_URL;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, null, seen));
  const sanitized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    sanitized[childKey] = sanitizeValue(childValue, childKey, seen);
  }
  return sanitized;
}

/** Convert the runtime image DTO into a presentation-only, non-secret DTO. */
export function presentImageResult(result: ImageResult): PresentedImageResult {
  return sanitizeValue(result, null, new WeakSet<object>()) as PresentedImageResult;
}

/** Human output is deliberately rendered from the already sanitized DTO. */
export function formatImageResultHuman(result: PresentedImageResult): string {
  return `Image ingest game ${result.gameId}: ${result.status}\n${JSON.stringify(result, null, 2)}`;
}
