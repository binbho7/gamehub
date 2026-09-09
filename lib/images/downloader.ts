import type { ImageCandidate } from "./candidates";
import { systemClock, type Clock, type TimerHandle } from "./clock";
import { validateImageSource } from "./source-policy";
import type { ImageTiming } from "./types";

const MAX_BODY_BYTES = 8_388_608;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2_048;
const HEADER_TIMEOUT_MS = 10_000;
const BODY_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type DownloadRequest = {
  candidate: ImageCandidate;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  now: () => number;
  maxRedirects?: number;
  maxUrlLength?: number;
  headerTimeoutMs?: number;
  bodyTimeoutMs?: number;
  clock?: Clock;
  onAttempt?: (attempt: DownloadHop) => void;
};

export type DownloadHop = {
  url: string;
  status: number | null;
  location: string | null;
  headers?: { contentType: string | null; contentLength: string | null };
  timing?: ImageTiming;
};

export type DownloadResult = {
  outcome: "downloaded" | "redirect_rejected" | "download_failed" | "deadline" | "too_large";
  attempts: DownloadHop[];
  finalUrl: string | null;
  httpStatus: number | null;
  contentType: string | null;
  bytes: Uint8Array | null;
  errorCode: string | null;
  byteCount?: number;
};

type DeadlineReason = "header_timeout" | "body_timeout" | "external_abort" | null;

function boundedWholeNumber(value: number | undefined, defaultValue: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function result(
  attempts: DownloadResult["attempts"],
  outcome: DownloadResult["outcome"],
  errorCode: string | null,
  values: Partial<Pick<DownloadResult, "finalUrl" | "httpStatus" | "contentType" | "bytes" | "byteCount">> = {},
): DownloadResult {
  return {
    outcome,
    attempts,
    finalUrl: values.finalUrl ?? null,
    httpStatus: values.httpStatus ?? null,
    contentType: values.contentType ?? null,
    bytes: values.bytes ?? null,
    errorCode,
    byteCount: values.byteCount ?? values.bytes?.byteLength ?? 0,
  };
}

function cancelBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // The body may already have been closed or cancelled by the runtime.
  }
}

function resolveLocation(location: string, currentUrl: string): string | null {
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}

function joinChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/** Race an operation with an AbortSignal, including signals that the operation ignores. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  // A timed-out operation may settle after the race has returned. Mark the
  // original promise handled so a late transport rejection cannot escape.
  void operation.catch(() => undefined);
  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  let removeListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(abortError());
    removeListener = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  return Promise.race([operation, aborted]).finally(() => removeListener?.());
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  // Do not wait for cancellation: a broken upstream must not defeat our deadline.
  void reader.cancel().catch(() => undefined);
}

export async function downloadImageSource(request: DownloadRequest): Promise<DownloadResult> {
  const attempts: DownloadResult["attempts"] = [];
  const clock = request.clock ?? systemClock;
  const startedAt = request.now();
  const deadlineAt = startedAt + BODY_TIMEOUT_MS;
  const maxRedirects = boundedWholeNumber(request.maxRedirects, MAX_REDIRECTS, MAX_REDIRECTS);
  const maxUrlLength = boundedWholeNumber(request.maxUrlLength, MAX_URL_LENGTH, MAX_URL_LENGTH);
  const headerTimeoutMs = boundedWholeNumber(request.headerTimeoutMs, HEADER_TIMEOUT_MS, HEADER_TIMEOUT_MS);
  const bodyTimeoutMs = boundedWholeNumber(request.bodyTimeoutMs, BODY_TIMEOUT_MS, BODY_TIMEOUT_MS);
  const controller = new AbortController();
  let deadlineReason: DeadlineReason = null;
  let headerTimer: TimerHandle | null = null;
  let bodyTimer: TimerHandle | null = null;

  const abortFor = (reason: Exclude<DeadlineReason, null>): void => {
    if (deadlineReason === null) deadlineReason = reason;
    controller.abort();
  };
  const onParentAbort = (): void => abortFor("external_abort");
  if (request.signal.aborted) onParentAbort();
  else request.signal.addEventListener("abort", onParentAbort, { once: true });

  const clearHeaderTimer = (): void => {
    if (headerTimer !== null) {
      clock.clearTimeout(headerTimer);
      headerTimer = null;
    }
  };
  const clearBodyTimer = (): void => {
    if (bodyTimer !== null) {
      clock.clearTimeout(bodyTimer);
      bodyTimer = null;
    }
  };

  const remainingMs = (): number => Math.max(0, deadlineAt - request.now());

  try {
    const initial = validateImageSource(request.candidate.sourceUrl, request.candidate.provider);
    if (!initial.ok || request.candidate.sourceUrl.length > maxUrlLength) {
      return result(attempts, "redirect_rejected", "source_rejected");
    }

    let currentUrl = new URL(initial.url).toString();
    const seen = new Set([currentUrl]);
    let redirects = 0;

    while (true) {
      const hopStartedAt = request.now();
      const recordAttempt = (status: number | null, location: string | null, headers?: Headers): void => {
        const finishedAt = request.now();
        const attempt: DownloadHop = {
          url: currentUrl, status, location,
          headers: { contentType: headers?.get("content-type") ?? null, contentLength: headers?.get("content-length") ?? null },
          timing: { startedAt: hopStartedAt, finishedAt, durationMs: Math.max(0, finishedAt - hopStartedAt) },
        };
        attempts.push(attempt);
        request.onAttempt?.(attempt);
      };
      if (controller.signal.aborted) {
        return result(attempts, "deadline", deadlineReason ?? "external_abort");
      }

      const remainingBeforeHeaders = remainingMs();
      if (remainingBeforeHeaders <= 0) {
        abortFor("body_timeout");
        return result(attempts, "deadline", "body_timeout");
      }
      headerTimer = clock.setTimeout(
        () => abortFor("header_timeout"),
        Math.min(headerTimeoutMs, remainingBeforeHeaders),
      );
      let response: Response;
      try {
        let fetched: Response | PromiseLike<Response>;
        try {
          fetched = request.fetchImpl(currentUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (error) {
          throw error;
        }
        const pendingResponse = Promise.resolve(fetched);
        void pendingResponse.then((lateResponse) => {
          if (controller.signal.aborted) void cancelBody(lateResponse);
        }, () => undefined);
        response = await withAbort(pendingResponse, controller.signal);
        if (controller.signal.aborted) {
          void pendingResponse.then((lateResponse) => cancelBody(lateResponse), () => undefined);
          recordAttempt(response.status, null, response.headers);
          cancelBody(response);
          return result(attempts, "deadline", deadlineReason ?? "external_abort");
        }
      } catch (error) {
        recordAttempt(null, null);
        if (deadlineReason !== null || (controller.signal.aborted && isAbortError(error))) {
          return result(attempts, "deadline", deadlineReason ?? "external_abort");
        }
        return result(attempts, "download_failed", "network_error");
      } finally {
        clearHeaderTimer();
      }

      const location = response.headers.get("location");
      recordAttempt(response.status, location, response.headers);

      if (!REDIRECT_STATUSES.has(response.status)) {
        const contentType = response.headers.get("content-type");
        if (response.status < 200 || response.status >= 300) {
          cancelBody(response);
          return result(attempts, "download_failed", "http_status", {
            finalUrl: currentUrl,
            httpStatus: response.status,
            contentType,
          });
        }

        const declaredLengthHeader = response.headers.get("content-length");
        const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
        if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
          cancelBody(response);
          return result(attempts, "too_large", "content_length", {
            finalUrl: currentUrl,
            httpStatus: response.status,
            contentType,
          });
        }

        if (response.body === null) {
          return result(attempts, "downloaded", null, {
            finalUrl: currentUrl,
            httpStatus: response.status,
            contentType,
            bytes: new Uint8Array(),
          });
        }

        const remainingForBody = remainingMs();
        if (remainingForBody <= 0) {
          cancelBody(response);
          return result(attempts, "deadline", "body_timeout", {
            finalUrl: currentUrl,
            httpStatus: response.status,
            contentType,
          });
        }
        bodyTimer = clock.setTimeout(() => abortFor("body_timeout"), Math.min(bodyTimeoutMs, remainingForBody));
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        let naturallyClosed = false;
        try {
          while (true) {
            const next = await withAbort(reader.read(), controller.signal);
            if (next.done) {
              naturallyClosed = true;
              break;
            }
            byteLength += next.value.byteLength;
            if (byteLength > MAX_BODY_BYTES) {
              cancelReader(reader);
              controller.abort();
              return result(attempts, "too_large", "body_size", {
                byteCount: byteLength,
                finalUrl: currentUrl,
                httpStatus: response.status,
                contentType,
              });
            }
            chunks.push(next.value);
          }
        } catch (error) {
          if (deadlineReason !== null || (controller.signal.aborted && isAbortError(error))) {
            cancelReader(reader);
            return result(attempts, "deadline", deadlineReason ?? "external_abort", {
              byteCount: byteLength,
              finalUrl: currentUrl,
              httpStatus: response.status,
              contentType,
            });
          }
          cancelReader(reader);
          return result(attempts, "download_failed", "body_read", {
            byteCount: byteLength,
            finalUrl: currentUrl,
            httpStatus: response.status,
            contentType,
          });
        } finally {
          clearBodyTimer();
          if (!naturallyClosed) cancelReader(reader);
          reader.releaseLock();
        }

        return result(attempts, "downloaded", null, {
          finalUrl: currentUrl,
          httpStatus: response.status,
          contentType,
          bytes: joinChunks(chunks, byteLength),
        });
      }

      cancelBody(response);
      if (location === null || location.length === 0 || location.length > maxUrlLength) {
        return result(attempts, "redirect_rejected", "invalid_location", { httpStatus: response.status });
      }
      const target = resolveLocation(location, currentUrl);
      if (target === null || target.length > maxUrlLength) {
        return result(attempts, "redirect_rejected", "invalid_location", { httpStatus: response.status });
      }
      const validated = validateImageSource(target, request.candidate.provider);
      if (!validated.ok) {
        return result(attempts, "redirect_rejected", "target_rejected", { httpStatus: response.status });
      }
      if (seen.has(validated.url)) {
        return result(attempts, "redirect_rejected", "redirect_loop", { httpStatus: response.status });
      }
      if (redirects >= maxRedirects) {
        return result(attempts, "redirect_rejected", "redirect_limit", { httpStatus: response.status });
      }

      redirects += 1;
      seen.add(validated.url);
      currentUrl = validated.url;
    }
  } finally {
    clearHeaderTimer();
    clearBodyTimer();
    request.signal.removeEventListener("abort", onParentAbort);
  }
}
