import { z } from "zod";
import { parseScheduledMutationAuthority, type ScheduledMutationAuthority } from "../scheduler/types";
import { parseImageWorkerResponse } from "./worker-client";
import type { ImageResult } from "./types";

export const SCHEDULED_IMAGE_PATH = "/internal/v1/images/ingest-scheduled";
export const SCHEDULED_IMAGE_REQUEST_LIMIT = 16 * 1024;
export const SCHEDULED_IMAGE_RESPONSE_LIMIT = 1024 * 1024;
export type ScheduledImageRequest = { version: 1; mode: "scheduled"; requestId: string; gameId: number; write: true; authority: ScheduledMutationAuthority };
export type ScheduledImageResponse = { version: 1; requestId: string; authorityStatus: "not_observed_lost" | "fence_lost"; result: ImageResult };
const requestSchema = z.strictObject({ version: z.literal(1), mode: z.literal("scheduled"), requestId: z.uuid(), gameId: z.number().int().safe().positive(), write: z.literal(true), authority: z.unknown().transform(parseScheduledMutationAuthority) });
const responseSchema = z.strictObject({ version: z.literal(1), requestId: z.uuid(), authorityStatus: z.enum(["not_observed_lost", "fence_lost"]), result: z.unknown() });

function decode(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength > limit) throw new Error("Image body too large");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Preserve duplicate-key evidence, including escaped spellings, before JSON.parse.
  let offset = 0;
  const whitespace = () => { while (offset < text.length && /\s/.test(text[offset])) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) { const char = text[offset++]; if (char === '"') return JSON.parse(text.slice(start, offset)); if (char === "\\") offset++; }
    throw new Error("Invalid image JSON");
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Error("Invalid image JSON depth");
    whitespace(); const char = text[offset];
    if (char === '"') { string(); return; }
    if (char === "{" || char === "[") {
      offset++; const end = char === "{" ? "}" : "]"; const keys = new Set<string>(); whitespace();
      if (text[offset] === end) { offset++; return; }
      while (offset < text.length) {
        if (char === "{") { whitespace(); if (text[offset] !== '"') throw new Error("Invalid image JSON"); const key = string(); if (keys.has(key)) throw new Error("Duplicate image JSON key"); keys.add(key); whitespace(); if (text[offset++] !== ":") throw new Error("Invalid image JSON"); }
        value(depth + 1); whitespace(); const separator = text[offset++]; if (separator === end) return; if (separator !== ",") throw new Error("Invalid image JSON");
      }
      throw new Error("Invalid image JSON");
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++;
    if (offset === start) throw new Error("Invalid image JSON");
  };
  value(0); whitespace(); if (offset !== text.length) throw new Error("Invalid image JSON");
  return JSON.parse(text);
}
export function parseScheduledImageRequest(bytes: Uint8Array): ScheduledImageRequest {
  return requestSchema.parse(decode(bytes, SCHEDULED_IMAGE_REQUEST_LIMIT));
}
export function parseScheduledImageResponse(bytes: Uint8Array, request: ScheduledImageRequest): ScheduledImageResponse {
  const envelope = responseSchema.parse(decode(bytes, SCHEDULED_IMAGE_RESPONSE_LIMIT));
  if (envelope.requestId !== request.requestId) throw new Error("Image request identity mismatch");
  return { ...envelope, result: parseImageWorkerResponse(envelope.result, request.gameId, true) };
}
export async function readScheduledImageBody(message: Pick<Response, "body" | "headers">, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const length = message.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error("Invalid image body size");
  if (!message.body) throw new Error("Missing image body");
  const reader = message.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Image body aborted");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error("Image body aborted");
      if (done) break;
      total += value.byteLength; if (total > limit) { cancel(); throw new Error("Image body too large"); } chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
}
