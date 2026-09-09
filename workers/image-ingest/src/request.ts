import type { WorkerRequestDto } from "../../../lib/images/types";

const MAX_BODY_BYTES = 1024;

function invalidRequest(): Error {
  return new Error("invalid_request");
}

async function readBodyAtMost(request: Request): Promise<Uint8Array> {
  const advertised = request.headers.get("Content-Length");
  if (advertised !== null) {
    if (!/^\d+$/.test(advertised)) throw invalidRequest();
    const length = Number(advertised);
    if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) throw invalidRequest();
  }

  if (request.body === null) throw invalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw invalidRequest();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function parseWorkerRequest(request: Request): Promise<WorkerRequestDto> {
  let bytes: Uint8Array;
  try {
    bytes = await readBodyAtMost(request);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_request") throw error;
    throw invalidRequest();
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw invalidRequest();
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidRequest();
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "gameId" || keys[1] !== "write") throw invalidRequest();
  if (!Number.isSafeInteger(record.gameId) || (record.gameId as number) <= 0 || typeof record.write !== "boolean") {
    throw invalidRequest();
  }
  return { gameId: record.gameId as number, write: record.write };
}

export { MAX_BODY_BYTES };
