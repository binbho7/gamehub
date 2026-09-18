import type { VerificationCode } from "../types";

export type VerifierWireRequest = { version: 1; operation: "verify_official_link"; requestId: string; exactUrl: string; budgetMs: number };
export type VerifierServiceErrorCode = "verifier_service_unavailable" | "verifier_timeout" | "verifier_protocol_error" | "verifier_auth_error" | "verifier_invalid_response";
export type RemoteVerifierError = { code: VerifierServiceErrorCode; message: string };
export type WireAttempt = { method: "HEAD" | "GET"; url: string; resolvedAddress: string | null; addressFamily: 4 | 6 | null; httpStatus: number | null; startedAtMs: number; finishedAtMs: number };
export type WireRedirectHop = { fromUrl: string; status: 301 | 302 | 303 | 307 | 308; location: string; resolvedUrl: string | null };
export type WireTerminalOutcome = { code: VerificationCode; attempts: WireAttempt[]; redirectChain: WireRedirectHop[]; finalUrl: string | null; httpStatus: number | null; checkedAtMs: number };
export type VerifierWireResponse = { version: 1; requestId: string; status: "completed"; outcome: WireTerminalOutcome } | { version: 1; requestId: string; status: "failed"; error: RemoteVerifierError };
export type RemoteVerifierRequest = VerifierWireRequest;
export type RemoteVerifierResponse = VerifierWireResponse;
export type PrivateVerifierBinding = { start(timeoutMs: number): Promise<void>; fetch(request: Request): Promise<Response> };
export type VerifierMacHeaders = { requestId: string; timestampMs: string; mac: string };

export const VERIFIER_PATH = "/internal/v1/official-links/verify";
export const MAX_REQUEST_BYTES = 16384;
export const MAX_RESPONSE_BYTES = 262144;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
