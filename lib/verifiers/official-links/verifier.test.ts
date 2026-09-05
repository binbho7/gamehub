import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovedDestination } from "./destination";
import { normalizeIpAddress } from "./ip-safety";
import { executeRedirectChain, type ExecuteRedirectChain } from "./redirect";
import type { RequestHeaders } from "./transport";
import type {
  HttpMethod,
  RedirectHop,
  TerminalOutcome,
  VerificationAttempt,
  VerificationCode,
} from "./types";
import { verifyUrl } from "./verifier";

const EXACT_URL = "https://www.example.org/start?token=exact#fragment";
const CHECKED_AT = new Date("2026-09-04T12:00:00.000Z");

function attempt(method: HttpMethod, url = EXACT_URL, status: number | null = null) {
  return {
    method,
    url,
    resolvedAddress: "8.8.8.8",
    addressFamily: 4,
    httpStatus: status,
    startedAt: new Date("2026-09-04T11:59:59.000Z"),
    finishedAt: new Date("2026-09-04T11:59:59.010Z"),
  } satisfies VerificationAttempt;
}

function outcome(input: {
  method: HttpMethod;
  code?: VerificationCode;
  status?: number | null;
  attempts?: VerificationAttempt[];
  redirectChain?: RedirectHop[];
  finalUrl?: string | null;
  checkedAt?: Date;
}): TerminalOutcome {
  const status = input.status ?? null;
  return {
    code: input.code ?? "http_result",
    attempts: input.attempts ?? [attempt(input.method, EXACT_URL, status)],
    redirectChain: input.redirectChain ?? [],
    finalUrl: input.finalUrl === undefined
      ? input.code === undefined || input.code === "http_result" ? EXACT_URL : null
      : input.finalUrl,
    httpStatus: status,
    checkedAt: input.checkedAt ?? CHECKED_AT,
  };
}

function sequenceExecutor(outcomes: TerminalOutcome[]) {
  let index = 0;
  return vi.fn<ExecuteRedirectChain>(async () => {
    const next = outcomes[index];
    index += 1;
    if (next === undefined) throw new Error("Unexpected redirect-chain execution");
    return next;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("verifyUrl HEAD decision", () => {
  it.each([400, 403, 404, 405, 501])(
    "falls back to GET only after terminal HEAD status %s",
    async (status) => {
      const head = outcome({ method: "HEAD", status });
      const get = outcome({
        method: "GET",
        status: 204,
        finalUrl: "https://cdn.example.net/final",
        checkedAt: new Date("2026-09-04T12:00:01.000Z"),
      });
      const executeChain = sequenceExecutor([head, get]);

      const result = await verifyUrl(EXACT_URL, { executeChain });

      expect(executeChain.mock.calls.map(([url, method]) => [url, method])).toEqual([
        [EXACT_URL, "HEAD"],
        [EXACT_URL, "GET"],
      ]);
      expect(result).toEqual({
        ...get,
        attempts: [...head.attempts, ...get.attempts],
      });
    },
  );

  it.each([
    ["successful response", outcome({ method: "HEAD", status: 200 })],
    ["no-content response", outcome({ method: "HEAD", status: 204 })],
    ["300 response", outcome({ method: "HEAD", status: 300 })],
    ["304 response", outcome({ method: "HEAD", status: 304 })],
    ["401 response", outcome({ method: "HEAD", status: 401 })],
    ["410 response", outcome({ method: "HEAD", status: 410 })],
    ["429 response", outcome({ method: "HEAD", status: 429 })],
    ["500 response", outcome({ method: "HEAD", status: 500 })],
    ["599 response", outcome({ method: "HEAD", status: 599 })],
    ["timeout", outcome({ method: "HEAD", code: "timeout" })],
    ["DNS failure", outcome({ method: "HEAD", code: "dns_failure", attempts: [] })],
    ["TLS failure", outcome({ method: "HEAD", code: "tls_error" })],
    ["connection failure", outcome({ method: "HEAD", code: "network_error" })],
    ["unsafe destination", outcome({ method: "HEAD", code: "unsafe_destination" })],
    ["protocol downgrade", outcome({ method: "HEAD", code: "protocol_downgrade" })],
    ["redirect loop", outcome({ method: "HEAD", code: "redirect_loop" })],
    ["redirect excess", outcome({ method: "HEAD", code: "too_many_redirects" })],
    ["invalid redirect", outcome({ method: "HEAD", code: "invalid_redirect" })],
    ["invalid URL", outcome({ method: "HEAD", code: "invalid_url", attempts: [] })],
    ["unsupported scheme", outcome({ method: "HEAD", code: "unsupported_scheme", attempts: [] })],
  ])("does not issue GET after %s", async (_label, head) => {
    const executeChain = sequenceExecutor([head]);

    const result = await verifyUrl(EXACT_URL, { executeChain });

    expect(executeChain).toHaveBeenCalledOnce();
    expect(executeChain.mock.calls[0]?.slice(0, 2)).toEqual([EXACT_URL, "HEAD"]);
    expect(result).toEqual(head);
  });

  it("does not fallback when a failure happens to retain a fallback HTTP status", async () => {
    const head = outcome({ method: "HEAD", code: "unsafe_destination", status: 403 });
    const executeChain = sequenceExecutor([head]);

    const result = await verifyUrl(EXACT_URL, { executeChain });

    expect(executeChain).toHaveBeenCalledOnce();
    expect(result).toEqual(head);
  });
});

describe("verifyUrl GET isolation", () => {
  it("returns only the fresh GET chain while retaining HEAD and GET attempt evidence", async () => {
    const headRedirect: RedirectHop = {
      fromUrl: EXACT_URL,
      status: 302,
      location: "/head-terminal",
      resolvedUrl: "https://www.example.org/head-terminal",
    };
    const getRedirect: RedirectHop = {
      fromUrl: EXACT_URL,
      status: 307,
      location: "https://cdn.example.net/get-terminal",
      resolvedUrl: "https://cdn.example.net/get-terminal",
    };
    const head = outcome({
      method: "HEAD",
      status: 405,
      redirectChain: [headRedirect],
      finalUrl: "https://www.example.org/head-terminal",
      attempts: [
        attempt("HEAD", EXACT_URL, 302),
        attempt("HEAD", "https://www.example.org/head-terminal", 405),
      ],
    });
    const get = outcome({
      method: "GET",
      status: 200,
      redirectChain: [getRedirect],
      finalUrl: "https://cdn.example.net/get-terminal",
      attempts: [
        attempt("GET", EXACT_URL, 307),
        attempt("GET", "https://cdn.example.net/get-terminal", 200),
      ],
    });
    const executeChain = sequenceExecutor([head, get]);

    const result = await verifyUrl(EXACT_URL, { executeChain });

    expect(executeChain.mock.calls.map(([url, method]) => [url, method])).toEqual([
      [EXACT_URL, "HEAD"],
      [EXACT_URL, "GET"],
    ]);
    expect(result.redirectChain).toEqual([getRedirect]);
    expect(result.finalUrl).toBe("https://cdn.example.net/get-terminal");
    expect(result.attempts).toEqual([...head.attempts, ...get.attempts]);
  });

  it("shares the five-redirect budget across HEAD and GET chains", async () => {
    const head = outcome({
      method: "HEAD",
      status: 405,
      redirectChain: [
        { fromUrl: EXACT_URL, status: 301, location: "/one", resolvedUrl: "https://www.example.org/one" },
        { fromUrl: "https://www.example.org/one", status: 302, location: "/two", resolvedUrl: "https://www.example.org/two" },
      ],
    });
    const get = outcome({ method: "GET", status: 200 });
    const executeChain = sequenceExecutor([head, get]);

    await verifyUrl(EXACT_URL, { executeChain });

    expect(executeChain.mock.calls[0]?.[3]).toMatchObject({ maxRedirects: 5 });
    expect(executeChain.mock.calls[1]?.[3]).toMatchObject({ maxRedirects: 3 });
  });

  it("restarts through the real redirect engine and repeats destination safety checks", async () => {
    const selectedAddress = normalizeIpAddress("8.8.8.8");
    if (selectedAddress === null) throw new Error("Invalid public fixture address");

    const resolvedUrls: string[] = [];
    const requested: Array<[string, HttpMethod]> = [];
    const resolveDestination = vi.fn(async (target) => {
      resolvedUrls.push(target.exactUrl);
      if (target.exactUrl === "https://unsafe.example.net/private") {
        return { ok: false as const, code: "unsafe_destination" as const };
      }
      return {
        ok: true as const,
        value: { ...target, selectedAddress } satisfies ApprovedDestination,
      };
    });
    const planned = [
      { status: 302, locations: ["/head-terminal"] },
      { status: 405, locations: [] },
      { status: 302, locations: ["https://unsafe.example.net/private"] },
    ];
    const request = vi.fn<RequestHeaders>(async (destination, method) => {
      requested.push([destination.exactUrl, method]);
      const next = planned.shift();
      if (next === undefined) throw new Error("Unexpected request");
      return {
        kind: "response",
        status: next.status,
        locations: next.locations,
        attempt: attempt(method, destination.exactUrl, next.status),
      };
    });
    const boundExecuteChain = vi.fn<ExecuteRedirectChain>(
      (url, method, _unusedDependencies, options) => executeRedirectChain(
        url,
        method,
        { resolveDestination, request, now: () => CHECKED_AT },
        options,
      ),
    );

    const result = await verifyUrl(EXACT_URL, { executeChain: boundExecuteChain });

    expect(resolvedUrls).toEqual([
      EXACT_URL,
      "https://www.example.org/head-terminal",
      EXACT_URL,
      "https://unsafe.example.net/private",
    ]);
    expect(requested).toEqual([
      [EXACT_URL, "HEAD"],
      ["https://www.example.org/head-terminal", "HEAD"],
      [EXACT_URL, "GET"],
    ]);
    expect(result).toMatchObject({
      code: "unsafe_destination",
      finalUrl: null,
      httpStatus: 302,
      redirectChain: [
        {
          fromUrl: EXACT_URL,
          status: 302,
          location: "https://unsafe.example.net/private",
          resolvedUrl: "https://unsafe.example.net/private",
        },
      ],
    });
    expect(result.attempts.map(({ method, url }) => [method, url])).toEqual([
      ["HEAD", EXACT_URL],
      ["HEAD", "https://www.example.org/head-terminal"],
      ["GET", EXACT_URL],
    ]);
  });
});

describe("verifyUrl deadline", () => {
  it("aborts an outstanding GET at one combined 20-second deadline", async () => {
    vi.useFakeTimers();
    const head = outcome({ method: "HEAD", status: 405 });
    const observedSignals: AbortSignal[] = [];
    const executeChain = vi.fn<ExecuteRedirectChain>((_url, method, _deps, options) => {
      if (options?.signal !== undefined) observedSignals.push(options.signal);
      if (method === "HEAD") {
        return new Promise((resolve) => setTimeout(() => resolve(head), 12_000));
      }
      return new Promise(() => undefined);
    });

    let settled = false;
    const verification = verifyUrl(EXACT_URL, { executeChain }).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    expect(executeChain.mock.calls.map(([, method]) => method)).toEqual(["HEAD", "GET"]);
    await vi.advanceTimersByTimeAsync(1);
    const result = await verification;

    expect(result).toMatchObject({
      code: "timeout",
      attempts: head.attempts,
      redirectChain: [],
      finalUrl: null,
      httpStatus: null,
    });
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals[0]).toBe(observedSignals[1]);
    expect(observedSignals[0]?.aborted).toBe(true);
  });

  it("caps an oversized deadline option at 20 seconds", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const executeChain = vi.fn<ExecuteRedirectChain>((_url, _method, _deps, options) => {
      observedSignal = options?.signal;
      return new Promise(() => undefined);
    });

    let settled = false;
    const verification = verifyUrl(
      EXACT_URL,
      { executeChain },
      { linkDeadlineMs: 90_000 },
    ).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await verification).code).toBe("timeout");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("retains completed HEAD evidence when GET settles from the shared abort", async () => {
    vi.useFakeTimers();
    const head = outcome({ method: "HEAD", status: 405 });
    const getTimeout = outcome({
      method: "GET",
      code: "timeout",
      attempts: [attempt("GET")],
    });
    const executeChain = vi.fn<ExecuteRedirectChain>((_url, method, _deps, options) => {
      if (method === "HEAD") return Promise.resolve(head);
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(getTimeout), { once: true });
      });
    });

    const verification = verifyUrl(
      EXACT_URL,
      { executeChain },
      { linkDeadlineMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);

    expect((await verification).attempts).toEqual([
      ...head.attempts,
      ...getTimeout.attempts,
    ]);
  });

  it("uses a stricter injected deadline and forwards parent aborts", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const executeChain = vi.fn<ExecuteRedirectChain>((_url, _method, _deps, options) => {
      observedSignal = options?.signal;
      return new Promise(() => undefined);
    });

    const verification = verifyUrl(
      EXACT_URL,
      { executeChain },
      { linkDeadlineMs: 500, signal: parent.signal },
    );
    parent.abort();

    const result = await verification;
    expect(result.code).toBe("timeout");
    expect(observedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
