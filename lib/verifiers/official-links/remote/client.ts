import type { OfficialLinkVerificationTransport } from "../verification-transport";
import type { TerminalOutcome } from "../types";
import { parseVerifierRequest, parseVerifierResponse, readVerifierBody } from "./codec";
import { isVerifierServiceError, VerifierServiceError } from "./errors";
import { signVerifierRequest, verifyVerifierResponse } from "./mac";
import { MAX_RESPONSE_BYTES, VERIFIER_PATH, type PrivateVerifierBinding, type VerifierWireRequest } from "./types";

export function createRemoteVerifierTransport(input: { binding: PrivateVerifierBinding; secret: string; nowMs: () => number; newRequestId: () => string }): OfficialLinkVerificationTransport {
  return {
    async verify(exactUrl, options = {}) {
      const native = (code: "invalid_url" | "timeout"): TerminalOutcome => ({ code, attempts: [], redirectChain: [], finalUrl: null, httpStatus: null, checkedAt: new Date(input.nowMs()) });
      if (options.signal?.aborted) return native("timeout");
      if (exactUrl.length === 0 || exactUrl.length > 2048) return native("invalid_url");
      const budget = options.linkDeadlineMs === undefined || !Number.isFinite(options.linkDeadlineMs) ? 20000 : Math.min(20000, Math.max(0, Math.floor(options.linkDeadlineMs)));
      if (budget === 0) return native("timeout");
      const expiresAt = input.nowMs() + budget;
      const controller = new AbortController();
      let rejectDeadline: (error: VerifierServiceError) => void = () => {};
      const expired = new Promise<never>((_, reject) => { rejectDeadline = reject; });
      const abort = () => { controller.abort(); rejectDeadline(new VerifierServiceError("verifier_timeout")); };
      const timer = setTimeout(abort, budget);
      options.signal?.addEventListener("abort", abort, { once: true });
      const remaining = () => {
        const value = Math.floor(expiresAt - input.nowMs());
        if (value <= 0 || controller.signal.aborted) throw new VerifierServiceError("verifier_timeout");
        return value;
      };
      const work = async (): Promise<TerminalOutcome> => {
        let startupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const startupBudget = Math.min(10000, remaining());
          await Promise.race([
            input.binding.start(startupBudget),
            new Promise<never>((_, reject) => {
              startupTimer = setTimeout(() => reject(new VerifierServiceError("verifier_service_unavailable")), startupBudget);
            }),
            expired,
          ]);
        } finally { clearTimeout(startupTimer); }
        const request: VerifierWireRequest = { version: 1, operation: "verify_official_link", requestId: input.newRequestId(), exactUrl, budgetMs: remaining() };
        const body = new TextEncoder().encode(JSON.stringify(request));
        parseVerifierRequest(body);
        const signed = await signVerifierRequest(input.secret, body, request.requestId, input.nowMs());
        remaining();
        const response = await input.binding.fetch(new Request(`http://official-link-verifier${VERIFIER_PATH}`, {
          method: "POST", redirect: "manual", signal: controller.signal, body,
          headers: { "Content-Type": "application/json", "X-GameHub-Request-Id": signed.requestId, "X-GameHub-Timestamp": signed.timestampMs, "X-GameHub-Mac": signed.mac },
        }));
        const rejectResponse = (code: ConstructorParameters<typeof VerifierServiceError>[0]): never => {
          void response.body?.cancel().catch(() => {});
          throw new VerifierServiceError(code);
        };
        try { remaining(); } catch { rejectResponse("verifier_timeout"); }
        if (response.status === 401 || response.status === 403) rejectResponse("verifier_auth_error");
        if (response.status >= 500 || response.status === 429) rejectResponse("verifier_service_unavailable");
        if (response.status === 413) rejectResponse("verifier_invalid_response");
        if (response.redirected || (response.status !== 200 && response.status !== 400)) rejectResponse("verifier_protocol_error");
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("Content-Type") ?? "") || (response.headers.has("Content-Encoding") && response.headers.get("Content-Encoding") !== "identity")) rejectResponse("verifier_protocol_error");
        const responseBytes = await readVerifierBody(response, MAX_RESPONSE_BYTES, controller.signal);
        const mac = response.headers.get("X-GameHub-Mac");
        if (!mac) throw new VerifierServiceError("verifier_protocol_error");
        if (!await verifyVerifierResponse(input.secret, body, request.requestId, response.status, responseBytes, mac)) throw new VerifierServiceError("verifier_auth_error");
        remaining();
        const result = parseVerifierResponse(responseBytes, request);
        if (response.status !== 200) throw new VerifierServiceError("verifier_protocol_error");
        return result;
      };
      try { return await Promise.race([work(), expired]); }
      catch (error) {
        if (controller.signal.aborted) throw new VerifierServiceError("verifier_timeout");
        if (isVerifierServiceError(error)) throw error;
        throw new VerifierServiceError("verifier_service_unavailable");
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      }
    },
  };
}
