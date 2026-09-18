import type { VerifierServiceErrorCode } from "./types";

const messages: Record<VerifierServiceErrorCode, string> = {
  verifier_service_unavailable: "Official-link verifier service is unavailable.",
  verifier_timeout: "Official-link verifier request timed out.",
  verifier_protocol_error: "Official-link verifier protocol is unsupported.",
  verifier_auth_error: "Official-link verifier authentication failed.",
  verifier_invalid_response: "Official-link verifier returned an invalid response.",
};
const branded = new WeakSet<object>();
export class VerifierServiceError extends Error {
  readonly code: VerifierServiceErrorCode;
  constructor(code: VerifierServiceErrorCode) {
    super(messages[code]);
    this.name = "VerifierServiceError";
    this.code = code;
    branded.add(this);
    Object.freeze(this);
  }
}
export function isVerifierServiceError(value: unknown): value is VerifierServiceError {
  return typeof value === "object" && value !== null && branded.has(value);
}
export function isVerifierServiceErrorCode(value: unknown): value is VerifierServiceErrorCode {
  return typeof value === "string" && Object.hasOwn(messages, value);
}
