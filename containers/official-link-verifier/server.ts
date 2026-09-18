import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { encodeVerifierOutcome, parseVerifierRequest } from "../../lib/verifiers/official-links/remote/codec";
import { VerifierServiceError } from "../../lib/verifiers/official-links/remote/errors";
import { signVerifierResponse, verifyVerifierRequest } from "../../lib/verifiers/official-links/remote/mac";
import { MAX_REQUEST_BYTES, UUID_PATTERN, VERIFIER_PATH, type VerifierServiceErrorCode } from "../../lib/verifiers/official-links/remote/types";
import type { OfficialLinkVerificationTransport } from "../../lib/verifiers/official-links/verification-transport";

function header(request: IncomingMessage, name: string): string {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0] : "";
}

function send(response: ServerResponse, status: number, body: Uint8Array, mac?: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json", "Content-Length": body.byteLength,
    "Cache-Control": "no-store", Connection: "close",
    ...(mac ? { "X-GameHub-Mac": mac } : {}),
  });
  response.end(body);
}

// Count actual bytes, including chunked bodies. Never accumulate beyond the cap.
function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", data); request.off("end", end);
      request.off("error", fail); request.off("aborted", fail);
    };
    const fail = () => { cleanup(); reject(400); };
    const data = (chunk: Buffer) => {
      length += chunk.byteLength;
      if (length > MAX_REQUEST_BYTES) { cleanup(); request.pause(); reject(413); return; }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, length)); };
    const timer = setTimeout(fail, 5000);
    request.on("data", data); request.once("end", end);
    request.once("error", fail); request.once("aborted", fail);
  });
}

export function createVerifierServer(input: { secret: string; transport: OfficialLinkVerificationTransport; nowMs: () => number }) {
  if (Buffer.byteLength(input.secret, "utf8") < 32) throw new Error("Verifier secret must contain at least 32 bytes");
  let active = false;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const auth = { requestId: header(request, "x-gamehub-request-id"), timestampMs: header(request, "x-gamehub-timestamp"), mac: header(request, "x-gamehub-mac") };
    const unsigned = (status: number) => send(response, status, Buffer.from('{"error":"Request rejected."}'));
    if (!UUID_PATTERN.test(auth.requestId) || !/^[0-9a-f]{64}$/.test(auth.mac) || !/^(0|[1-9][0-9]{0,15})$/.test(auth.timestampMs)) { unsigned(401); return; }
    let body: Uint8Array;
    try { body = await readBody(request); } catch (status) { unsigned(status === 413 ? 413 : 400); return; }
    if (!await verifyVerifierRequest(input.secret, body, auth, input.nowMs())) { unsigned(401); return; }
    const signed = async (status: number, bytes: Uint8Array) => {
      const mac = await signVerifierResponse(input.secret, body, auth.requestId, status, bytes);
      send(response, status, bytes, mac);
    };
    const failed = (status: number, code: VerifierServiceErrorCode) => signed(status, Buffer.from(JSON.stringify({
      version: 1, requestId: auth.requestId, status: "failed", error: { code, message: new VerifierServiceError(code).message },
    })));
    if (request.url !== VERIFIER_PATH) { await failed(404, "verifier_protocol_error"); return; }
    if (request.method !== "POST") { await failed(405, "verifier_protocol_error"); return; }
    if ((request.headers["content-encoding"] !== undefined && header(request, "content-encoding") !== "identity") || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(request, "content-type"))) { await failed(400, "verifier_protocol_error"); return; }
    let parsed;
    try {
      parsed = parseVerifierRequest(body);
      if (parsed.requestId !== auth.requestId) throw new Error("Mismatched request ID");
    } catch { await failed(400, "verifier_protocol_error"); return; }
    if (active) { await failed(503, "verifier_service_unavailable"); return; }
    if (response.destroyed || request.aborted) return;
    active = true;
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    response.once("close", disconnect);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new VerifierServiceError("verifier_timeout"));
          controller.abort();
        }, parsed.budgetMs);
      });
      // Retain the concurrency slot until target work settles, including after
      // client disconnect. The secure transport destroys sockets on abort.
      const work = Promise.resolve().then(() => input.transport.verify(parsed.exactUrl, {
        linkDeadlineMs: parsed.budgetMs, signal: controller.signal,
      })).finally(() => { active = false; });
      const outcome = await Promise.race([work, deadline]);
      await signed(200, encodeVerifierOutcome(auth.requestId, outcome));
    } catch (error) {
      await failed(503, error instanceof VerifierServiceError && error.code === "verifier_timeout" ? "verifier_timeout" : "verifier_service_unavailable");
    } finally {
      clearTimeout(timer);
      response.off("close", disconnect);
      controller.abort();
    }
  };
  return createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000 }, (request, response) => {
    void handle(request, response).catch(() => { response.destroy(); });
  });
}
