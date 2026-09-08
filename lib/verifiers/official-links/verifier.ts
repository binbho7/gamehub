import type { ExecuteRedirectChain } from "./redirect";
import type { TerminalOutcome, VerificationAttempt } from "./types";

const DEFAULT_LINK_DEADLINE_MS = 20_000;
const ABORT_SETTLEMENT_MICROTASK_TURNS = 8;
const MAX_REDIRECTS = 5;
const GET_FALLBACK_STATUSES = new Set([400, 403, 404, 405, 501]);

export type ExecuteBoundRedirectChain = (
  originalExactUrl: Parameters<ExecuteRedirectChain>[0],
  method: Parameters<ExecuteRedirectChain>[1],
  options?: Parameters<ExecuteRedirectChain>[3],
) => ReturnType<ExecuteRedirectChain>;

export type VerifyUrl = (
  exactUrl: string,
  dependencies: { executeChain: ExecuteBoundRedirectChain },
  options?: { linkDeadlineMs?: number; signal?: AbortSignal },
) => Promise<TerminalOutcome>;

function boundedDeadline(deadlineMs: number | undefined): number {
  if (deadlineMs === undefined || !Number.isFinite(deadlineMs)) {
    return DEFAULT_LINK_DEADLINE_MS;
  }

  return Math.min(DEFAULT_LINK_DEADLINE_MS, Math.max(0, Math.floor(deadlineMs)));
}

function timeoutOutcome(
  attempts: VerificationAttempt[],
  checkedAt = new Date(),
): TerminalOutcome {
  return {
    code: "timeout",
    attempts,
    redirectChain: [],
    finalUrl: null,
    httpStatus: null,
    checkedAt,
  };
}

function shouldFallback(outcome: TerminalOutcome): boolean {
  return outcome.code === "http_result" &&
    outcome.httpStatus !== null &&
    GET_FALLBACK_STATUSES.has(outcome.httpStatus);
}

function isAtOrBefore(date: Date, deadline: Date): boolean {
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) && timestamp <= deadline.getTime();
}

function isDeadlineConsistentFailure(
  outcome: TerminalOutcome,
  deadline: Date,
): boolean {
  return outcome.code !== "http_result" &&
    outcome.finalUrl === null &&
    isAtOrBefore(outcome.checkedAt, deadline) &&
    outcome.attempts.every((attempt) =>
      isAtOrBefore(attempt.startedAt, deadline) &&
      isAtOrBefore(attempt.finishedAt, deadline)
    );
}

export const verifyUrl: VerifyUrl = async (
  exactUrl,
  dependencies,
  options = {},
) => {
  const controller = new AbortController();
  let completedAttempts: VerificationAttempt[] = [];
  let settleAbort: (() => void) | undefined;
  let abortStarted = false;
  let abortedAt: Date | undefined;
  const aborted = new Promise<{ source: "abort"; outcome: TerminalOutcome }>((resolve) => {
    settleAbort = () => resolve({
      source: "abort",
      outcome: timeoutOutcome([...completedAttempts], abortedAt),
    });
  });
  const abort = () => {
    if (abortStarted) return;
    abortStarted = true;
    abortedAt = new Date();
    controller.abort();
    let remainingTurns = ABORT_SETTLEMENT_MICROTASK_TURNS;
    const drain = () => {
      if (remainingTurns === 0) {
        settleAbort?.();
        return;
      }
      remainingTurns -= 1;
      queueMicrotask(drain);
    };
    queueMicrotask(drain);
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
        { maxRedirects: MAX_REDIRECTS, signal: controller.signal },
      ).then((outcome) => ({ source: "chain" as const, outcome })),
      aborted,
    ]);
    if (headResult.source === "abort") return headResult.outcome;

    const head = headResult.outcome;
    if (
      abortedAt !== undefined &&
      !isDeadlineConsistentFailure(head, abortedAt)
    ) {
      return timeoutOutcome([], abortedAt);
    }
    if (!shouldFallback(head)) return head;

    completedAttempts = head.attempts;
    const getResult = await Promise.race([
      dependencies.executeChain(
        exactUrl,
        "GET",
        {
          maxRedirects: Math.max(0, MAX_REDIRECTS - head.redirectChain.length),
          signal: controller.signal,
        },
      ).then((outcome) => ({ source: "chain" as const, outcome })),
      aborted,
    ]);

    if (getResult.source === "abort") return getResult.outcome;

    const get = getResult.outcome;
    if (
      abortedAt !== undefined &&
      !isDeadlineConsistentFailure(get, abortedAt)
    ) {
      return timeoutOutcome([...head.attempts], abortedAt);
    }
    return { ...get, attempts: [...head.attempts, ...get.attempts] };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
};
