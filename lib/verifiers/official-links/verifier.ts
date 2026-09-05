import type { ExecuteRedirectChain } from "./redirect";
import type { TerminalOutcome, VerificationAttempt } from "./types";

const DEFAULT_LINK_DEADLINE_MS = 20_000;
const MAX_REDIRECTS = 5;
const GET_FALLBACK_STATUSES = new Set([400, 403, 404, 405, 501]);

export type VerifyUrl = (
  exactUrl: string,
  dependencies: { executeChain: ExecuteRedirectChain },
  options?: { linkDeadlineMs?: number; signal?: AbortSignal },
) => Promise<TerminalOutcome>;

function boundedDeadline(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined || !Number.isFinite(deadlineMs)) {
    return DEFAULT_LINK_DEADLINE_MS;
  }

  return Math.min(DEFAULT_LINK_DEADLINE_MS, Math.max(0, Math.floor(deadlineMs)));
}

function timeoutOutcome(attempts: VerificationAttempt[]): TerminalOutcome {
  return {
    code: "timeout",
    attempts,
    redirectChain: [],
    finalUrl: null,
    httpStatus: null,
    checkedAt: new Date(),
  };
}

function shouldFallback(outcome: TerminalOutcome): boolean {
  return outcome.code === "http_result" &&
    outcome.httpStatus !== null &&
    GET_FALLBACK_STATUSES.has(outcome.httpStatus);
}

const configuredDependencies = undefined as unknown as Parameters<ExecuteRedirectChain>[2];

export const verifyUrl: VerifyUrl = async (
  exactUrl,
  dependencies,
  options = {},
) => {
  const controller = new AbortController();
  let completedAttempts: VerificationAttempt[] = [];
  let settleAbort: (() => void) | undefined;
  const aborted = new Promise<{ source: "abort"; outcome: TerminalOutcome }>((resolve) => {
    settleAbort = () => resolve({
      source: "abort",
      outcome: timeoutOutcome([...completedAttempts]),
    });
  });
  const abort = () => {
    controller.abort();
    queueMicrotask(() => settleAbort?.());
  };
  const parentSignal = options.signal;
  const timer = setTimeout(abort, boundedDeadline(options.linkDeadlineMs));

  if (parentSignal?.aborted) {
    abort();
  } else {
    parentSignal?.addEventListener("abort", abort, { once: true });
  }

  try {
    const headResult = await Promise.race([
      dependencies.executeChain(
        exactUrl,
        "HEAD",
        configuredDependencies,
        { maxRedirects: MAX_REDIRECTS, signal: controller.signal },
      ).then((outcome) => ({ source: "chain" as const, outcome })),
      aborted,
    ]);
    if (headResult.source === "abort") return headResult.outcome;

    const head = headResult.outcome;
    if (!shouldFallback(head)) return head;

    completedAttempts = head.attempts;
    const getResult = await Promise.race([
      dependencies.executeChain(
        exactUrl,
        "GET",
        configuredDependencies,
        {
          maxRedirects: Math.max(0, MAX_REDIRECTS - head.redirectChain.length),
          signal: controller.signal,
        },
      ).then((outcome) => ({ source: "chain" as const, outcome })),
      aborted,
    ]);

    if (getResult.source === "abort") return getResult.outcome;

    const get = getResult.outcome;
    return { ...get, attempts: [...head.attempts, ...get.attempts] };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
};
