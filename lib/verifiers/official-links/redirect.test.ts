import { describe, expect, it, vi } from "vitest";
import type {
  ApprovedDestination,
  DestinationResult,
  ResolveSafeDestination,
} from "./destination";
import { normalizeIpAddress } from "./ip-safety";
import { executeRedirectChain } from "./redirect";
import type {
  RequestHeaders,
  TransportFailure,
  TransportResponse,
} from "./transport";
import type { HttpMethod, VerificationAttempt } from "./types";

const CHECKED_AT = new Date("2026-09-04T12:00:00.000Z");
const ATTEMPT_STARTED_AT = new Date("2026-09-04T11:59:59.000Z");
const ATTEMPT_FINISHED_AT = new Date("2026-09-04T11:59:59.010Z");

type PlannedTransportResult =
  | { kind: "response"; status: number; locations?: string[] }
  | { kind: "failure"; code: TransportFailure["code"] };

type Harness = {
  resolveDestination: ReturnType<typeof vi.fn<ResolveSafeDestination>>;
  request: ReturnType<typeof vi.fn<RequestHeaders>>;
  requestedUrls: string[];
  resolvedUrls: string[];
};

function attempt(
  destination: ApprovedDestination,
  method: HttpMethod,
  httpStatus: number | null,
): VerificationAttempt {
  return {
    method,
    url: destination.exactUrl,
    resolvedAddress: destination.selectedAddress.address,
    addressFamily: destination.selectedAddress.family,
    httpStatus,
    startedAt: ATTEMPT_STARTED_AT,
    finishedAt: ATTEMPT_FINISHED_AT,
  };
}

function createHarness(
  planned: PlannedTransportResult[],
  destinationResult?: (exactUrl: string) => DestinationResult | undefined,
): Harness {
  const selectedAddress = normalizeIpAddress("8.8.8.8");
  if (selectedAddress === null) throw new Error("Invalid public fixture address");

  const requestedUrls: string[] = [];
  const resolvedUrls: string[] = [];
  let requestIndex = 0;
  const resolveDestination = vi.fn<ResolveSafeDestination>(async (target) => {
    resolvedUrls.push(target.exactUrl);
    const overridden = destinationResult?.(target.exactUrl);
    if (overridden !== undefined) return overridden;

    return {
      ok: true,
      value: { ...target, selectedAddress },
    };
  });
  const request = vi.fn<RequestHeaders>(async (destination, method) => {
    requestedUrls.push(destination.exactUrl);
    const next = planned[requestIndex];
    requestIndex += 1;
    if (next === undefined) throw new Error("Unexpected transport call");

    if (next.kind === "failure") {
      return {
        kind: "failure",
        code: next.code,
        attempt: attempt(destination, method, null),
      };
    }

    return {
      kind: "response",
      status: next.status,
      locations: next.locations ?? [],
      attempt: attempt(destination, method, next.status),
    } satisfies TransportResponse;
  });

  return { resolveDestination, request, requestedUrls, resolvedUrls };
}

async function run(
  originalExactUrl: string,
  planned: PlannedTransportResult[],
  options?: { maxRedirects?: number; locationMaxLength?: number; signal?: AbortSignal },
  destinationResult?: (exactUrl: string) => DestinationResult | undefined,
) {
  const harness = createHarness(planned, destinationResult);
  const outcome = await executeRedirectChain(
    originalExactUrl,
    "HEAD",
    {
      resolveDestination: harness.resolveDestination,
      request: harness.request,
      now: () => CHECKED_AT,
    },
    options,
  );

  return { outcome, ...harness };
}

describe("executeRedirectChain status and Location handling", () => {
  it.each([301, 302, 303, 307, 308] as const)(
    "follows supported redirect status %s",
    async (status) => {
      const { outcome, requestedUrls } = await run("https://www.example.org/start", [
        { kind: "response", status, locations: ["/next"] },
        { kind: "response", status: 204 },
      ]);

      expect(requestedUrls).toEqual([
        "https://www.example.org/start",
        "https://www.example.org/next",
      ]);
      expect(outcome).toMatchObject({
        code: "http_result",
        finalUrl: "https://www.example.org/next",
        httpStatus: 204,
        redirectChain: [
          {
            fromUrl: "https://www.example.org/start",
            status,
            location: "/next",
            resolvedUrl: "https://www.example.org/next",
          },
        ],
      });
      expect(outcome.attempts).toHaveLength(2);
    },
  );

  it.each([300, 304, 305, 306, 309, 399])(
    "treats non-followed 3xx status %s as a terminal response without requiring Location",
    async (status) => {
      const { outcome, resolveDestination, request } = await run(
        "https://www.example.org/start",
        [{ kind: "response", status }],
      );

      expect(outcome).toEqual({
        code: "http_result",
        attempts: [expect.objectContaining({ httpStatus: status })],
        redirectChain: [],
        finalUrl: "https://www.example.org/start",
        httpStatus: status,
        checkedAt: CHECKED_AT,
      });
      expect(resolveDestination).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("ignores Location on a terminal non-followed 3xx response", async () => {
    const { outcome, requestedUrls } = await run("https://www.example.org/start", [
      { kind: "response", status: 304, locations: ["https://other.example.org/ignored"] },
    ]);

    expect(outcome).toMatchObject({
      code: "http_result",
      httpStatus: 304,
      finalUrl: "https://www.example.org/start",
      redirectChain: [],
    });
    expect(requestedUrls).toEqual(["https://www.example.org/start"]);
  });

  it.each([
    ["missing", []],
    ["empty", [""]],
    ["whitespace-only", [" \t "]],
    ["multiple", ["/first", "/second"]],
    ["malformed", ["http://["]],
    ["overlong", [`https://next.example.org/${"x".repeat(2_049)}`]],
  ])("returns invalid_redirect for a %s Location", async (_label, locations) => {
    const { outcome, requestedUrls } = await run("https://www.example.org/start", [
      { kind: "response", status: 302, locations },
    ]);

    expect(outcome).toMatchObject({
      code: "invalid_redirect",
      finalUrl: null,
      httpStatus: 302,
    });
    expect(outcome.attempts).toHaveLength(1);
    expect(requestedUrls).toEqual(["https://www.example.org/start"]);
  });

  it("honors a stricter injected Location length bound", async () => {
    const { outcome, requestedUrls } = await run(
      "https://www.example.org/start",
      [{ kind: "response", status: 302, locations: ["/123456"] }],
      { locationMaxLength: 5 },
    );

    expect(outcome).toMatchObject({ code: "invalid_redirect", finalUrl: null });
    expect(requestedUrls).toEqual(["https://www.example.org/start"]);
  });

  it("accepts a Location and resolved target exactly 2,048 characters long", async () => {
    const prefix = "https://next.example.org/";
    const location = `${prefix}${"x".repeat(2_048 - prefix.length)}`;
    const { outcome, requestedUrls } = await run("https://www.example.org/start", [
      { kind: "response", status: 302, locations: [location] },
      { kind: "response", status: 200 },
    ]);

    expect(location).toHaveLength(2_048);
    expect(outcome).toMatchObject({ code: "http_result", finalUrl: location });
    expect(requestedUrls).toEqual(["https://www.example.org/start", location]);
  });
});

describe("executeRedirectChain per-hop safety", () => {
  it("resolves relative, absolute, and cross-host redirects and allows HTTP to HTTPS", async () => {
    const { outcome, requestedUrls, resolvedUrls } = await run("http://www.example.org/start", [
      { kind: "response", status: 301, locations: ["../relative"] },
      {
        kind: "response",
        status: 302,
        locations: ["https://www.example.org/absolute"],
      },
      {
        kind: "response",
        status: 307,
        locations: ["https://cdn.example.net/final"],
      },
      { kind: "response", status: 200 },
    ]);

    const expectedUrls = [
      "http://www.example.org/start",
      "http://www.example.org/relative",
      "https://www.example.org/absolute",
      "https://cdn.example.net/final",
    ];
    expect(resolvedUrls).toEqual(expectedUrls);
    expect(requestedUrls).toEqual(expectedUrls);
    expect(outcome).toMatchObject({
      code: "http_result",
      finalUrl: "https://cdn.example.net/final",
      httpStatus: 200,
    });
    expect(outcome.redirectChain).toHaveLength(3);
    expect(outcome.attempts.map((entry) => entry.url)).toEqual(expectedUrls);
  });

  it("forbids HTTPS to HTTP without resolving or requesting the downgrade target", async () => {
    const { outcome, requestedUrls, resolvedUrls } = await run("https://www.example.org/start", [
      { kind: "response", status: 302, locations: ["http://www.example.org/plain"] },
    ]);

    expect(outcome).toMatchObject({
      code: "protocol_downgrade",
      finalUrl: null,
      httpStatus: 302,
      redirectChain: [
        {
          fromUrl: "https://www.example.org/start",
          status: 302,
          location: "http://www.example.org/plain",
          resolvedUrl: "http://www.example.org/plain",
        },
      ],
    });
    expect(resolvedUrls).toEqual(["https://www.example.org/start"]);
    expect(requestedUrls).toEqual(["https://www.example.org/start"]);
  });

  it.each([
    ["credentials", "https://user:secret@next.example.org/path", "unsafe_destination"],
    ["unsupported scheme", "ftp://next.example.org/path", "unsupported_scheme"],
    ["non-default port", "https://next.example.org:444/path", "unsafe_destination"],
  ] as const)(
    "rejects a %s redirect during fresh URL validation",
    async (_label, location, code) => {
      const { outcome, requestedUrls, resolvedUrls } = await run(
        "https://www.example.org/start",
        [{ kind: "response", status: 302, locations: [location] }],
      );

      expect(outcome).toMatchObject({ code, finalUrl: null, httpStatus: 302 });
      expect(requestedUrls).toEqual(["https://www.example.org/start"]);
      expect(resolvedUrls).toEqual(["https://www.example.org/start"]);
    },
  );

  it.each([
    ["private", "http://127.0.0.1/private"],
    ["reserved", "https://192.0.2.1/reserved"],
    ["mixed DNS", "https://mixed.example.net/path"],
  ])("rejects a %s redirect after fresh destination classification", async (_label, location) => {
    const { outcome, requestedUrls, resolvedUrls } = await run(
      "http://www.example.org/start",
      [{ kind: "response", status: 302, locations: [location] }],
      undefined,
      (exactUrl) => exactUrl === location
        ? { ok: false, code: "unsafe_destination" }
        : undefined,
    );

    expect(outcome).toMatchObject({
      code: "unsafe_destination",
      finalUrl: null,
      httpStatus: 302,
      redirectChain: [expect.objectContaining({ location, resolvedUrl: location })],
    });
    expect(resolvedUrls).toEqual(["http://www.example.org/start", location]);
    expect(requestedUrls).toEqual(["http://www.example.org/start"]);
  });

  it.each(["dns_failure", "timeout"] as const)(
    "preserves the sanitized %s destination result for a redirect target",
    async (code) => {
      const location = "https://unresolved.example.net/path";
      const { outcome } = await run(
        "https://www.example.org/start",
        [{ kind: "response", status: 302, locations: [location] }],
        undefined,
        (exactUrl) => exactUrl === location ? { ok: false, code } : undefined,
      );

      expect(outcome).toMatchObject({ code, finalUrl: null, httpStatus: 302 });
    },
  );

  it("re-runs destination resolution and bound transport independently for every followed hop", async () => {
    const controller = new AbortController();
    const { outcome, resolveDestination, request } = await run(
      "https://one.example.org/start",
      [
        { kind: "response", status: 301, locations: ["https://two.example.org/next"] },
        { kind: "response", status: 308, locations: ["https://three.example.org/final"] },
        { kind: "response", status: 204 },
      ],
      { signal: controller.signal },
    );

    expect(outcome.code).toBe("http_result");
    expect(resolveDestination).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenCalledTimes(3);
    for (const call of resolveDestination.mock.calls) {
      expect(call[1]).toBe(controller.signal);
    }
    for (const call of request.mock.calls) {
      expect(call[2]).toEqual({ signal: controller.signal });
    }
    expect(resolveDestination.mock.calls[0][0]).not.toBe(resolveDestination.mock.calls[1][0]);
    expect(request.mock.calls[0][0]).not.toBe(request.mock.calls[1][0]);
  });

  it("returns a sanitized transport failure with the exact completed attempt history", async () => {
    const { outcome } = await run("https://www.example.org/start", [
      { kind: "response", status: 302, locations: ["/next"] },
      { kind: "failure", code: "tls_error" },
    ]);

    expect(outcome).toMatchObject({
      code: "tls_error",
      finalUrl: null,
      httpStatus: null,
      checkedAt: CHECKED_AT,
    });
    expect(outcome.attempts.map((entry) => [entry.url, entry.httpStatus])).toEqual([
      ["https://www.example.org/start", 302],
      ["https://www.example.org/next", null],
    ]);
    expect(outcome.redirectChain).toEqual([
      {
        fromUrl: "https://www.example.org/start",
        status: 302,
        location: "/next",
        resolvedUrl: "https://www.example.org/next",
      },
    ]);
  });
});

describe("executeRedirectChain limits and canonical identity", () => {
  it("detects a loop across host case, a trailing root label, a default port, and fragments", async () => {
    const original = "https://Example.COM.:443/start#first";
    const location = "https://example.com/start#second";
    const { outcome, requestedUrls, resolvedUrls } = await run(original, [
      { kind: "response", status: 302, locations: [location] },
    ]);

    expect(outcome).toMatchObject({
      code: "redirect_loop",
      finalUrl: null,
      httpStatus: 302,
      redirectChain: [
        {
          fromUrl: original,
          status: 302,
          location,
          resolvedUrl: location,
        },
      ],
    });
    expect(resolvedUrls).toEqual([original]);
    expect(requestedUrls).toEqual([original]);
  });

  it("allows five redirects and reaches the sixth response hop", async () => {
    const planned: PlannedTransportResult[] = Array.from({ length: 5 }, (_, index) => ({
      kind: "response" as const,
      status: 302,
      locations: [`/${index + 1}`],
    }));
    planned.push({ kind: "response", status: 200 });

    const { outcome, requestedUrls } = await run("https://www.example.org/0", planned);

    expect(outcome).toMatchObject({
      code: "http_result",
      finalUrl: "https://www.example.org/5",
      httpStatus: 200,
    });
    expect(requestedUrls).toHaveLength(6);
    expect(outcome.attempts).toHaveLength(6);
    expect(outcome.redirectChain).toHaveLength(5);
  });

  it("returns too_many_redirects for a sixth redirect without resolving or requesting its target", async () => {
    const planned: PlannedTransportResult[] = Array.from({ length: 6 }, (_, index) => ({
      kind: "response" as const,
      status: 302,
      locations: [`/${index + 1}`],
    }));

    const { outcome, requestedUrls, resolvedUrls } = await run(
      "https://www.example.org/0",
      planned,
    );

    expect(outcome).toMatchObject({
      code: "too_many_redirects",
      finalUrl: null,
      httpStatus: 302,
    });
    expect(outcome.attempts).toHaveLength(6);
    expect(outcome.redirectChain).toHaveLength(6);
    expect(outcome.redirectChain.at(-1)).toEqual({
      fromUrl: "https://www.example.org/5",
      status: 302,
      location: "/6",
      resolvedUrl: "https://www.example.org/6",
    });
    expect(requestedUrls).toHaveLength(6);
    expect(resolvedUrls).toHaveLength(6);
    expect(resolvedUrls).not.toContain("https://www.example.org/6");
  });

  it("supports a stricter redirect cap without opening the excess target", async () => {
    const { outcome, requestedUrls } = await run(
      "https://www.example.org/0",
      [
        { kind: "response", status: 302, locations: ["/1"] },
        { kind: "response", status: 302, locations: ["/2"] },
      ],
      { maxRedirects: 1 },
    );

    expect(outcome.code).toBe("too_many_redirects");
    expect(requestedUrls).toEqual([
      "https://www.example.org/0",
      "https://www.example.org/1",
    ]);
  });
});

describe("executeRedirectChain terminal failures", () => {
  it.each([
    ["not a URL", "invalid_url"],
    ["ftp://www.example.org/file", "unsupported_scheme"],
    ["https://user:secret@www.example.org/file", "unsafe_destination"],
  ] as const)("returns sanitized code %s before networking", async (raw, code) => {
    const { outcome, resolveDestination, request } = await run(raw, []);

    expect(outcome).toEqual({
      code,
      attempts: [],
      redirectChain: [],
      finalUrl: null,
      httpStatus: null,
      checkedAt: CHECKED_AT,
    });
    expect(resolveDestination).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("returns an initial destination failure without assigning the unreached URL as final", async () => {
    const original = "https://unresolved.example.org/path";
    const { outcome, request } = await run(
      original,
      [],
      undefined,
      (exactUrl) => exactUrl === original ? { ok: false, code: "dns_failure" } : undefined,
    );

    expect(outcome).toEqual({
      code: "dns_failure",
      attempts: [],
      redirectChain: [],
      finalUrl: null,
      httpStatus: null,
      checkedAt: CHECKED_AT,
    });
    expect(request).not.toHaveBeenCalled();
  });
});
