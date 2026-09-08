import type { ResolveSafeDestination } from "./destination";
import type { RequestHeaders } from "./transport";
import type {
  HttpMethod,
  RedirectHop,
  TerminalOutcome,
  VerificationAttempt,
  VerificationCode,
} from "./types";
import {
  resolveRedirectLocation,
  validateHttpUrl,
  type SafeHttpUrl,
} from "./url-safety";

const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_LOCATION_MAX_LENGTH = 2_048;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORBIDDEN_RAW_LOCATION_CHARACTERS = /[\u0000-\u0020\u007f]/;

type RedirectStatus = RedirectHop["status"];

export type ExecuteRedirectChain = (
  originalExactUrl: string,
  method: HttpMethod,
  dependencies: {
    resolveDestination: ResolveSafeDestination;
    request: RequestHeaders;
    now: () => Date;
  },
  options?: {
    maxRedirects?: number;
    locationMaxLength?: number;
    signal?: AbortSignal;
  },
) => Promise<TerminalOutcome>;

function boundedOption(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function isRedirectStatus(status: number): status is RedirectStatus {
  return REDIRECT_STATUSES.has(status);
}

function canonicalUrlIdentity(target: SafeHttpUrl): string {
  return JSON.stringify([
    target.protocol,
    target.hostname,
    target.port,
    target.requestUrl.pathname,
    target.requestUrl.search,
  ]);
}

function outcome(
  code: VerificationCode,
  attempts: VerificationAttempt[],
  redirectChain: RedirectHop[],
  checkedAt: Date,
  options: { finalUrl?: string; httpStatus?: number },
): TerminalOutcome {
  return {
    code,
    attempts,
    redirectChain,
    finalUrl: options.finalUrl ?? null,
    httpStatus: options.httpStatus ?? null,
    checkedAt,
  };
}

export const executeRedirectChain: ExecuteRedirectChain = async (
  originalExactUrl,
  method,
  dependencies,
  options = {},
) => {
  const attempts: VerificationAttempt[] = [];
  const redirectChain: RedirectHop[] = [];
  const maxRedirects = boundedOption(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
  const locationMaxLength = boundedOption(
    options.locationMaxLength,
    DEFAULT_LOCATION_MAX_LENGTH,
  );
  const finish = (
    code: VerificationCode,
    terminal?: { finalUrl?: string; httpStatus?: number },
  ) => outcome(code, attempts, redirectChain, dependencies.now(), terminal ?? {});

  const initial = validateHttpUrl(originalExactUrl);
  if (!initial.ok) return finish(initial.code);

  let current = initial.value;
  let followedRedirects = 0;
  let sourceRedirectStatus: RedirectStatus | undefined;
  const visited = new Set([canonicalUrlIdentity(current)]);

  while (true) {
    let destination;
    try {
      destination = await dependencies.resolveDestination(current, options.signal);
    } catch {
      return finish("dns_failure");
    }
    if (!destination.ok) {
      return finish(
        destination.code,
        sourceRedirectStatus === undefined ? undefined : { httpStatus: sourceRedirectStatus },
      );
    }

    let transportResult;
    try {
      transportResult = await dependencies.request(destination.value, method, {
        signal: options.signal,
      });
    } catch {
      return finish("network_error");
    }
    attempts.push(transportResult.attempt);

    if (transportResult.kind === "failure") {
      return finish(transportResult.code);
    }

    const { status, locations } = transportResult;
    if (!isRedirectStatus(status)) {
      return finish("http_result", {
        finalUrl: current.exactUrl,
        httpStatus: status,
      });
    }

    const rawLocation = Array.isArray(locations) && locations.length === 1
      ? locations[0]
      : undefined;
    if (
      typeof rawLocation !== "string" ||
      rawLocation.trim().length === 0 ||
      FORBIDDEN_RAW_LOCATION_CHARACTERS.test(rawLocation) ||
      rawLocation.length > locationMaxLength
    ) {
      if (typeof rawLocation === "string") {
        redirectChain.push({
          fromUrl: current.exactUrl,
          status,
          location: rawLocation,
          resolvedUrl: null,
        });
      }
      return finish("invalid_redirect", { httpStatus: status });
    }

    const resolved = resolveRedirectLocation(current.exactUrl, rawLocation);
    if (!resolved.ok) {
      redirectChain.push({
        fromUrl: current.exactUrl,
        status,
        location: rawLocation,
        resolvedUrl: null,
      });
      return finish(
        resolved.code === "invalid_url" ? "invalid_redirect" : resolved.code,
        { httpStatus: status },
      );
    }

    const next = resolved.value;
    redirectChain.push({
      fromUrl: current.exactUrl,
      status,
      location: rawLocation,
      resolvedUrl: next.exactUrl,
    });

    if (current.protocol === "https:" && next.protocol === "http:") {
      return finish("protocol_downgrade", { httpStatus: status });
    }

    const nextIdentity = canonicalUrlIdentity(next);
    if (visited.has(nextIdentity)) {
      return finish("redirect_loop", { httpStatus: status });
    }

    if (followedRedirects >= maxRedirects) {
      return finish("too_many_redirects", { httpStatus: status });
    }

    followedRedirects += 1;
    visited.add(nextIdentity);
    sourceRedirectStatus = status;
    current = next;
  }
};
