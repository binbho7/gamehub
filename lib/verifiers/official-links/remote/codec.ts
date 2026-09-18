import { z } from "zod";
import type { TerminalOutcome } from "../types";
import { isVerifierServiceError, isVerifierServiceErrorCode, VerifierServiceError } from "./errors";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, UUID_PATTERN, type VerifierWireRequest, type WireTerminalOutcome } from "./types";

const invalid = (): never => { throw new VerifierServiceError("verifier_invalid_response"); };
const protocol = (): never => { throw new VerifierServiceError("verifier_protocol_error"); };
const url = z.string().min(1).max(2048);
const time = z.number().int().min(0).max(8640000000000000);
const status = z.number().int().min(100).max(599).nullable();
const redirectStatuses = [301, 302, 303, 307, 308] as const;
const redirectStatus = z.union(redirectStatuses.map(value => z.literal(value)));
const isRedirect = (value: number | null) => value !== null && (redirectStatuses as readonly number[]).includes(value);
const fallback = (value: number | null) => value !== null && [400, 403, 404, 405, 501].includes(value);
const requestSchema = z.strictObject({ version: z.literal(1), operation: z.literal("verify_official_link"), requestId: z.string().regex(UUID_PATTERN), exactUrl: z.string().max(2048), budgetMs: z.number().int().min(1).max(20000) });
const outcomeSchema = z.strictObject({
  code: z.enum(["http_result", "invalid_url", "unsupported_scheme", "unsafe_destination", "dns_failure", "timeout", "network_error", "tls_error", "redirect_loop", "too_many_redirects", "invalid_redirect", "protocol_downgrade"]),
  attempts: z.array(z.strictObject({ method: z.enum(["HEAD", "GET"]), url, resolvedAddress: z.string().min(1).max(45).nullable(), addressFamily: z.union([z.literal(4), z.literal(6)]).nullable(), httpStatus: status, startedAtMs: time, finishedAtMs: time })).max(12),
  redirectChain: z.array(z.strictObject({ fromUrl: url, status: redirectStatus, location: z.string().max(16384), resolvedUrl: url.nullable() })).max(6),
  finalUrl: url.nullable(), httpStatus: status, checkedAtMs: time,
});

// A lexical pass detects duplicate decoded object keys before JSON.parse can
// discard evidence. Depth is bounded independently of the byte limit.
function rejectDuplicateKeys(text: string): void {
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[offset] ?? "!") && offset < text.length) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return JSON.parse(text.slice(start, offset)) as string;
      if (char === "\\") offset++;
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > 32) invalid();
    whitespace();
    const char = text[offset];
    if (char === '"') { string(); return; }
    if (char === "{" || char === "[") {
      offset++;
      const end = char === "{" ? "}" : "]";
      const keys = new Set<string>();
      whitespace();
      if (text[offset] === end) { offset++; return; }
      while (offset < text.length) {
        if (char === "{") {
          whitespace();
          if (text[offset] !== '"') invalid();
          const key = string();
          if (keys.has(key)) invalid();
          keys.add(key);
          whitespace();
          if (text[offset++] !== ":") invalid();
        }
        value(depth + 1);
        whitespace();
        const separator = text[offset++];
        if (separator === end) return;
        if (separator !== ",") invalid();
      }
      invalid();
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++;
    if (offset === start) invalid();
  };
  value(0);
  whitespace();
  if (offset !== text.length) invalid();
}
function decode(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength > limit) invalid();
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rejectDuplicateKeys(text);
    return JSON.parse(text);
  } catch { return invalid(); }
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : protocol();
}
export function parseVerifierRequest(bytes: Uint8Array): VerifierWireRequest {
  const value = record(decode(bytes, MAX_REQUEST_BYTES));
  if (value.version !== 1 || value.operation !== "verify_official_link") protocol();
  const result = requestSchema.safeParse(value);
  return result.success ? result.data : invalid();
}

function validAddress(address: string | null, family: 4 | 6 | null): boolean {
  if (address === null || family === null) return address === null && family === null;
  if (family === 4) return /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(address) && address.split(".").every(part => Number(part) <= 255);
  if (!/^[0-9a-f:.]+$/i.test(address) || !address.includes(":")) return false;
  try { return new URL(`http://[${address}]/`).hostname.startsWith("["); } catch { return false; }
}
function identity(raw: string): string {
  try {
    const value = new URL(raw);
    const hostname = value.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    return JSON.stringify([value.protocol, hostname, value.port || (value.protocol === "https:" ? "443" : "80"), value.pathname, value.search]);
  } catch { return invalid(); }
}
function validateLayout(outcome: WireTerminalOutcome, request: VerifierWireRequest): void {
  const { attempts, redirectChain: hops, code } = outcome;
  let previousTime = 0;
  let getStart = -1;
  let blockCount = 0;
  let blockVisited = new Set<string>();
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    const parsedUrl = new URL(attempt.url);
    if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.port) invalid();
    if (attempt.startedAtMs < previousTime || attempt.finishedAtMs < attempt.startedAtMs || attempt.finishedAtMs > outcome.checkedAtMs || !validAddress(attempt.resolvedAddress, attempt.addressFamily)) invalid();
    previousTime = attempt.finishedAtMs;
    if (attempt.httpStatus !== null && attempt.resolvedAddress === null) invalid();
    if (index === 0 && (attempt.method !== "HEAD" || attempt.url !== request.exactUrl)) invalid();
    if (attempt.method === "GET" && getStart === -1) {
      if (index === 0 || !fallback(attempts[index - 1].httpStatus) || attempt.url !== request.exactUrl) invalid();
      getStart = index;
      blockCount = 0;
      blockVisited = new Set();
    }
    if (++blockCount > 6 || blockVisited.has(identity(attempt.url))) invalid();
    blockVisited.add(identity(attempt.url));
    if (getStart !== -1 && attempt.method !== "GET") invalid();
    if (index > 0 && attempt.method === attempts[index - 1].method && !isRedirect(attempts[index - 1].httpStatus)) invalid();
    if (index > 0 && attempt.method === attempts[index - 1].method && new URL(attempts[index - 1].url).protocol === "https:" && parsedUrl.protocol === "http:") invalid();
  }
  const last = attempts.at(-1);
  if (code === "http_result") {
    if (!last || outcome.httpStatus === null || isRedirect(outcome.httpStatus) || outcome.finalUrl !== last.url || outcome.httpStatus !== last.httpStatus) invalid();
  } else if (outcome.finalUrl !== null) invalid();
  // GET can fail in resolution or before request() returns an attempt. V2.5
  // retains the completed HEAD block, but returns GET's empty chain and null
  // terminal fields. Only failures reachable before that first attempt qualify;
  // TLS failures, for example, always carry their own transport attempt.
  if (hops.length === 0 && outcome.httpStatus === null && getStart === -1) {
    if (code === "timeout" && !last) return;
    if (last && fallback(last.httpStatus) && ["dns_failure", "unsafe_destination", "network_error", "timeout"].includes(code)) return;
  }
  const block = attempts.slice(getStart === -1 ? 0 : getStart);
  if (block.length > 6 || (getStart > 6) || block.length < hops.length || block.length > hops.length + 1) invalid();
  let current = request.exactUrl;
  const visited = new Set<string>();
  if (hops.length) visited.add(identity(current));
  for (let index = 0; index < hops.length; index++) {
    const hop = hops[index];
    const attempt = block[index];
    if (hop.fromUrl !== current || attempt.url !== current || attempt.httpStatus !== hop.status) invalid();
    if (hop.resolvedUrl !== null) {
      if (!hop.location || hop.location.length > 2048 || /[\u0000-\u0020\u007f]/.test(hop.location)) invalid();
      try { if (new URL(hop.location, current).href !== hop.resolvedUrl) invalid(); } catch { invalid(); }
    }
    const followed = index < block.length - 1;
    if (followed) {
      if (hop.resolvedUrl === null || block[index + 1].url !== hop.resolvedUrl) invalid();
      if (new URL(current).protocol === "https:" && new URL(hop.resolvedUrl!).protocol === "http:") invalid();
      const nextIdentity = identity(hop.resolvedUrl!);
      if (visited.has(nextIdentity)) invalid();
      visited.add(nextIdentity);
      current = hop.resolvedUrl!;
    } else if (index !== hops.length - 1) invalid();
  }
  if (block.length && block[0].url !== request.exactUrl) invalid();
  if (code === "http_result" && block.length !== hops.length + 1) invalid();
  if (code === "invalid_url" && (attempts.length || hops.length || outcome.httpStatus !== null)) invalid();
  const rejection = ["redirect_loop", "too_many_redirects", "protocol_downgrade"].includes(code);
  const tail = hops.at(-1);
  if (rejection && (!tail || tail.resolvedUrl === null || block.length !== hops.length || outcome.httpStatus !== tail.status)) invalid();
  if (code === "protocol_downgrade" && !(new URL(tail!.fromUrl).protocol === "https:" && new URL(tail!.resolvedUrl!).protocol === "http:")) invalid();
  if (code === "redirect_loop" && !visited.has(identity(tail!.resolvedUrl!))) invalid();
  // The HEAD block's redirect count is attempts minus its terminal request.
  if (code === "too_many_redirects" && hops.length - 1 + Math.max(0, getStart - 1) !== 5) invalid();
  if (code === "invalid_redirect" && (!last || !isRedirect(last.httpStatus) || outcome.httpStatus !== last.httpStatus || (tail && block.length === hops.length && tail.resolvedUrl !== null))) invalid();
  if (["network_error", "tls_error"].includes(code) && outcome.httpStatus !== null) invalid();
  if (code !== "http_result" && last?.httpStatus !== null && last !== undefined && !isRedirect(last.httpStatus)) invalid();
  if (code === "tls_error" && (!last || last.httpStatus !== null)) invalid();
  if (code === "dns_failure" && block.length > hops.length) invalid();
  if (code === "timeout" && outcome.httpStatus !== null && (!tail || block.length !== hops.length)) invalid();
  if (Math.max(0, getStart - 1) + Math.max(0, block.length - 1) > 5) invalid();
  if (outcome.httpStatus !== null && code !== "http_result" && (!last || !isRedirect(outcome.httpStatus) || last.httpStatus !== outcome.httpStatus)) invalid();
  if (["dns_failure", "unsafe_destination", "unsupported_scheme"].includes(code) && outcome.httpStatus !== null && (!tail || block.length !== hops.length)) invalid();
  if (code === "unsupported_scheme" && attempts.length && (!tail || tail.resolvedUrl !== null)) invalid();
  if (hops.length && block.length === hops.length && !rejection && !["invalid_redirect", "unsafe_destination", "unsupported_scheme", "dns_failure", "timeout", "network_error"].includes(code)) invalid();
}
export function parseVerifierResponse(bytes: Uint8Array, request: VerifierWireRequest): TerminalOutcome {
  const value = record(decode(bytes, MAX_RESPONSE_BYTES));
  if (value.version !== 1 || value.status === undefined || value.requestId === undefined) protocol();
  if (value.requestId !== request.requestId) invalid();
  if (value.status === "failed") {
    if (Object.keys(value).sort().join() !== "error,requestId,status,version") invalid();
    const error = record(value.error);
    if (Object.keys(error).sort().join() !== "code,message" || typeof error.message !== "string" || error.message.length > 256) invalid();
    if (!isVerifierServiceErrorCode(error.code)) return invalid();
    throw new VerifierServiceError(error.code);
  }
  if (value.status !== "completed") invalid();
  if (value.outcome === undefined) protocol();
  if (Object.keys(value).sort().join() !== "outcome,requestId,status,version") invalid();
  const parsed = outcomeSchema.safeParse(value.outcome);
  if (!parsed.success) invalid();
  const wire = parsed.data!;
  try { validateLayout(wire, request); } catch (error) { if (isVerifierServiceError(error)) throw error; invalid(); }
  return { code: wire.code, attempts: wire.attempts.map(({ startedAtMs, finishedAtMs, ...attempt }) => ({ ...attempt, startedAt: new Date(startedAtMs), finishedAt: new Date(finishedAtMs) })), redirectChain: wire.redirectChain, finalUrl: wire.finalUrl, httpStatus: wire.httpStatus, checkedAt: new Date(wire.checkedAtMs) };
}
export function encodeVerifierOutcome(requestId: string, outcome: TerminalOutcome): Uint8Array {
  const wire = { code: outcome.code, attempts: outcome.attempts.map(({ startedAt, finishedAt, ...attempt }) => ({ ...attempt, startedAtMs: startedAt.getTime(), finishedAtMs: finishedAt.getTime() })), redirectChain: outcome.redirectChain, finalUrl: outcome.finalUrl, httpStatus: outcome.httpStatus, checkedAtMs: outcome.checkedAt.getTime() };
  if (!UUID_PATTERN.test(requestId) || !outcomeSchema.safeParse(wire).success) protocol();
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, requestId, status: "completed", outcome: wire }));
  if (bytes.byteLength > MAX_RESPONSE_BYTES) protocol();
  return bytes;
}
export async function readVerifierBody(response: Pick<Response, "body">, maximum: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (signal?.aborted) throw new VerifierServiceError("verifier_timeout");
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new VerifierServiceError("verifier_timeout");
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { cancel(); invalid(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
