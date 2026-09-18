import type { TerminalOutcome } from "./types";

export interface OfficialLinkVerificationTransport {
  verify(exactUrl: string, options?: { linkDeadlineMs?: number; signal?: AbortSignal }): Promise<TerminalOutcome>;
}
