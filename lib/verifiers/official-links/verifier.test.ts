import { EventEmitter } from "node:events";
import type {
  ClientRequest,
  IncomingMessage,
  RequestOptions,
} from "node:http";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { ApprovedDestination } from "./destination";
import { normalizeIpAddress } from "./ip-safety";
import { executeRedirectChain } from "./redirect";
import {
  createRequestHeaders,
  type NodeRequestFactory,
  type RequestHeaders,
} from "./transport";
import type {
  HttpMethod,
  RedirectHop,
  TerminalOutcome,
  VerificationAttempt,
  VerificationCode,
} from "./types";
import { verifyUrl, type ExecuteBoundRedirectChain } from "./verifier";

const EXACT_URL = "https://www.example.org/start?token=exact#fragment";
const CHECKED_AT = new Date("2026-09-04T12:00:00.000Z");

class LayeredSocket extends EventEmitter {
  destroyed = false;

  constructor(public remoteAddress: string | undefined) {
    super();
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class LayeredResponse extends EventEmitter {
  destroyed = false;
  headers: Record<string, string | string[]> = {};

  constructor(
    public statusCode: number,
    public rawHeaders: string[] = [],
  ) {
    super();
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class LayeredRequest extends EventEmitter {
  destroyed = false;

  constructor(private readonly onEnd: () => void) {
    super();
  }

  end(): this {
    queueMicrotask(this.onEnd);
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function layeredRequestFactory(
  plans: Array<{ status?: number; locations?: string[] }>,
  calls: RequestOptions[],
  responses: LayeredResponse[],
): NodeRequestFactory {
  return (options, callback) => {
    const plan = plans.shift();
    if (plan === undefined) throw new Error("Unexpected layered transport request");
    calls.push(options);

    const request = new LayeredRequest(() => {
      const socket = new LayeredSocket("8.8.8.8");
      request.emit("socket", socket);
      socket.emit("secureConnect");
      if (plan.status === undefined) return;

      const rawHeaders = (plan.locations ?? []).flatMap((location) => [
        "Location",
        location,
      ]);
      const response = new LayeredResponse(plan.status, rawHeaders);
      responses.push(response);
      callback(response as unknown as IncomingMessage);
    });
    return request as unknown as ClientRequest;
  };
}

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
  return vi.fn<ExecuteBoundRedirectChain>(async () => {
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
      expect(executeChain.mock.calls.every((call) => call.length === 3)).toBe(true);
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
  it("requires Task 7 dependencies to be bound before injection", () => {
    expectTypeOf(executeRedirectChain).not.toExtend<ExecuteBoundRedirectChain>();
  });

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

    expect(executeChain.mock.calls[0]?.[2]).toMatchObject({ maxRedirects: 5 });
    expect(executeChain.mock.calls[1]?.[2]).toMatchObject({ maxRedirects: 3 });
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
    const boundExecuteChain = vi.fn<ExecuteBoundRedirectChain>(
      (url, method, options) => executeRedirectChain(
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
  it("aborts GET and settles a non-cooperative executor at exactly 20 seconds", async () => {
    vi.useFakeTimers();
    const head = outcome({ method: "HEAD", status: 405 });
    const observedSignals: AbortSignal[] = [];
    const executeChain = vi.fn<ExecuteBoundRedirectChain>((_url, method, options) => {
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
    expect(settled).toBe(true);
    expect(observedSignals).toHaveLength(2);
    expect(observedSignals[0]).toBe(observedSignals[1]);
    expect(observedSignals[0]?.aborted).toBe(true);
    const result = await verification;

    expect(result).toMatchObject({
      code: "timeout",
      attempts: head.attempts,
      redirectChain: [],
      finalUrl: null,
      httpStatus: null,
    });
  });

  it("caps an oversized deadline option at 20 seconds", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const executeChain = vi.fn<ExecuteBoundRedirectChain>((_url, _method, options) => {
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
    expect(settled).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect((await verification).code).toBe("timeout");
  });

  it("retains completed HEAD evidence when GET settles from the shared abort", async () => {
    vi.useFakeTimers();
    const head = outcome({ method: "HEAD", status: 405 });
    const getTimeout = outcome({
      method: "GET",
      code: "timeout",
      attempts: [attempt("GET")],
    });
    const executeChain = vi.fn<ExecuteBoundRedirectChain>((_url, method, options) => {
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

  it("prefers the real redirect and transport timeout provenance after abort", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const selectedAddress = normalizeIpAddress("8.8.8.8");
    if (selectedAddress === null) throw new Error("Invalid public fixture address");

    const calls: RequestOptions[] = [];
    const responses: LayeredResponse[] = [];
    const factory = layeredRequestFactory(
      [
        { status: 405 },
        { status: 302, locations: ["/slow"] },
        {},
      ],
      calls,
      responses,
    );
    const request = createRequestHeaders({
      httpRequest: factory,
      httpsRequest: factory,
      now: () => new Date(),
    });
    const resolveDestination = vi.fn(async (target) => ({
      ok: true as const,
      value: { ...target, selectedAddress } satisfies ApprovedDestination,
    }));
    const executeChain: ExecuteBoundRedirectChain = (url, method, options) =>
      executeRedirectChain(
        url,
        method,
        { resolveDestination, request, now: () => new Date() },
        options,
      );

    const verification = verifyUrl(
      EXACT_URL,
      { executeChain },
      { linkDeadlineMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map(({ method, path }) => [method, path])).toEqual([
      ["HEAD", "/start?token=exact"],
      ["GET", "/start?token=exact"],
      ["GET", "/slow"],
    ]);
    await vi.advanceTimersByTimeAsync(500);

    const result = await verification;
    expect(result).toEqual({
      code: "timeout",
      attempts: [
        expect.objectContaining({ method: "HEAD", httpStatus: 405 }),
        expect.objectContaining({ method: "GET", httpStatus: 302 }),
        expect.objectContaining({ method: "GET", httpStatus: null }),
      ],
      redirectChain: [
        {
          fromUrl: EXACT_URL,
          status: 302,
          location: "/slow",
          resolvedUrl: "https://www.example.org/slow",
        },
      ],
      finalUrl: null,
      httpStatus: null,
      checkedAt: new Date("2026-09-04T12:00:00.500Z"),
    });
    expect(responses).toHaveLength(2);
    expect(responses.every(({ destroyed }) => destroyed)).toBe(true);
  });

  it("rejects an HTTP success produced immediately after the deadline abort", async () => {
    vi.useFakeTimers();
    const lateSuccess = outcome({ method: "HEAD", status: 200 });
    const executeChain = vi.fn<ExecuteBoundRedirectChain>((_url, _method, options) =>
      new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          queueMicrotask(() => resolve(lateSuccess));
        }, { once: true });
      }));

    const verification = verifyUrl(
      EXACT_URL,
      { executeChain },
      { linkDeadlineMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(await verification).toMatchObject({
      code: "timeout",
      attempts: [],
      redirectChain: [],
      finalUrl: null,
      httpStatus: null,
    });
  });

  it("rejects a fallback GET success produced immediately after the deadline abort", async () => {
    vi.useFakeTimers();
    const head = outcome({ method: "HEAD", status: 405 });
    const lateSuccess = outcome({ method: "GET", status: 200 });
    const executeChain = vi.fn<ExecuteBoundRedirectChain>((_url, method, options) => {
      if (method === "HEAD") return Promise.resolve(head);
      return new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          queueMicrotask(() => resolve(lateSuccess));
        }, { once: true });
      });
    });

    const verification = verifyUrl(
      EXACT_URL,
      { executeChain },
      { linkDeadlineMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(await verification).toMatchObject({
      code: "timeout",
      attempts: head.attempts,
      redirectChain: [],
      finalUrl: null,
      httpStatus: null,
    });
  });

  it.each([
    ["checkedAt", new Date("2026-09-04T12:00:00.501Z"), new Date("2026-09-04T12:00:00.500Z")],
    ["attempt", new Date("2026-09-04T12:00:00.500Z"), new Date("2026-09-04T12:00:00.501Z")],
  ])(
    "rejects cooperative failure provenance when its %s timestamp exceeds the deadline",
    async (_label, checkedAt, finishedAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
      const lateFailure = outcome({
        method: "HEAD",
        code: "timeout",
        checkedAt,
        attempts: [{
          ...attempt("HEAD"),
          startedAt: new Date("2026-09-04T12:00:00.000Z"),
          finishedAt,
        }],
      });
      const executeChain = vi.fn<ExecuteBoundRedirectChain>((_url, _method, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener("abort", () => {
            queueMicrotask(() => resolve(lateFailure));
          }, { once: true });
        }));

      const verification = verifyUrl(
        EXACT_URL,
        { executeChain },
        { linkDeadlineMs: 500 },
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(await verification).toEqual({
        code: "timeout",
        attempts: [],
        redirectChain: [],
        finalUrl: null,
        httpStatus: null,
        checkedAt: new Date("2026-09-04T12:00:00.500Z"),
      });
    },
  );

  it("retains a non-HTTP failure stamped exactly at the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const deadlineAttempt = {
      ...attempt("HEAD"),
      startedAt: new Date("2026-09-04T12:00:00.000Z"),
      finishedAt: new Date("2026-09-04T12:00:00.500Z"),
    };
    const deadlineFailure = outcome({
      method: "HEAD",
      code: "network_error",
      attempts: [deadlineAttempt],
      checkedAt: new Date("2026-09-04T12:00:00.500Z"),
    });
    const executeChain = vi.fn<ExecuteBoundRedirectChain>((_url, _method, options) =>
      new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => {
          queueMicrotask(() => resolve(deadlineFailure));
        }, { once: true });
      }));

    const verification = verifyUrl(
      EXACT_URL,
      { executeChain },
      { linkDeadlineMs: 500 },
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(await verification).toEqual(deadlineFailure);
  });

  it("uses a stricter injected deadline and forwards parent aborts", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const executeChain = vi.fn<ExecuteBoundRedirectChain>((_url, _method, options) => {
      observedSignal = options?.signal;
      return new Promise(() => undefined);
    });

    let settled = false;
    const verification = verifyUrl(
      EXACT_URL,
      { executeChain },
      { linkDeadlineMs: 500, signal: parent.signal },
    ).then((value) => {
      settled = true;
      return value;
    });
    parent.abort();

    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    const result = await verification;
    expect(result.code).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });
});
