import { EventEmitter } from "node:events";
import type {
  ClientRequest,
  IncomingMessage,
  RequestOptions,
} from "node:http";
import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovedDestination } from "./destination";
import { normalizeIpAddress } from "./ip-safety";
import {
  createRequestHeaders,
  type NodeRequestFactory,
} from "./transport";
import { validateHttpUrl } from "./url-safety";

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;

  constructor(public remoteAddress: string | undefined) {
    super();
  }

  destroy(): this {
    this.destroyed = true;
    this.destroyCalls += 1;
    return this;
  }
}

class FakeRequest extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;
  ended = false;

  end(): this {
    this.ended = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.destroyCalls += 1;
    return this;
  }
}

class FakeResponse extends EventEmitter {
  destroyed = false;
  destroyCalls = 0;
  consumedBodyBytes = 0;
  headers: Record<string, string | string[]> = {};

  constructor(
    public statusCode: number | undefined,
    public rawHeaders: string[] = [],
  ) {
    super();
  }

  destroy(): this {
    this.destroyed = true;
    this.destroyCalls += 1;
    return this;
  }

  emitBody(chunk: string): void {
    if (this.destroyed) return;
    this.consumedBodyBytes += Buffer.byteLength(chunk);
    this.emit("data", Buffer.from(chunk));
  }
}

type RequestHarness = {
  calls: number;
  options: RequestOptions | null;
  callback: ((response: IncomingMessage) => void) | null;
  request: FakeRequest;
  factory: NodeRequestFactory;
};

function requestHarness(): RequestHarness {
  const harness: RequestHarness = {
    calls: 0,
    options: null,
    callback: null,
    request: new FakeRequest(),
    factory: (options, callback) => {
      harness.calls += 1;
      harness.options = options;
      harness.callback = callback;
      return harness.request as unknown as ClientRequest;
    },
  };

  return harness;
}

function approvedDestination(
  raw: string,
  selectedAddress: string,
): ApprovedDestination {
  const target = validateHttpUrl(raw);
  const normalized = normalizeIpAddress(selectedAddress);
  if (!target.ok || normalized === null) {
    throw new Error("Invalid approved destination fixture");
  }

  return { ...target.value, selectedAddress: normalized };
}

function requireCapturedOptions(harness: RequestHarness): RequestOptions {
  if (harness.options === null) throw new Error("Request factory was not called");
  return harness.options;
}

function connectRequest(
  harness: RequestHarness,
  remoteAddress: string | undefined,
  event: "connect" | "secureConnect",
): FakeSocket {
  const socket = new FakeSocket(remoteAddress);
  harness.request.emit("socket", socket);
  socket.emit(event);
  return socket;
}

function respond(
  harness: RequestHarness,
  status: number | undefined,
  rawHeaders: string[] = [],
): FakeResponse {
  const response = new FakeResponse(status, rawHeaders);
  const callback = harness.callback;
  if (callback === null) throw new Error("Request callback was not captured");
  callback(response as unknown as IncomingMessage);
  return response;
}

function runBoundLookup(
  options: RequestOptions,
  all = false,
): { address: string | LookupAddress[]; family: number | undefined } {
  const lookup = options.lookup;
  if (lookup === undefined) throw new Error("Missing request-bound lookup");

  let result:
    | { address: string | LookupAddress[]; family: number | undefined }
    | undefined;
  lookup(
    String(options.hostname),
    { all },
    (error, address, family) => {
      if (error !== null) throw error;
      result = { address, family };
    },
  );
  if (result === undefined) throw new Error("Request-bound lookup did not finish synchronously");
  return result;
}

function makeRequester(http = requestHarness(), https = requestHarness(), now?: () => Date) {
  return {
    http,
    https,
    request: createRequestHeaders({
      httpRequest: http.factory,
      httpsRequest: https.factory,
      now,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createRequestHeaders request binding", () => {
  it("binds HTTP to the approved address while preserving the logical host and URL path", async () => {
    const { http, https, request } = makeRequester();
    const destination = approvedDestination(
      "http://Games.Example.ORG./catalog?q=one#ignored",
      "8.8.8.8",
    );

    const pending = request(destination, "HEAD");
    const options = requireCapturedOptions(http);

    expect(https.calls).toBe(0);
    expect(options).toMatchObject({
      protocol: "http:",
      hostname: "games.example.org",
      port: 80,
      method: "HEAD",
      path: "/catalog?q=one",
      headers: { Host: "games.example.org" },
      family: 4,
      autoSelectFamily: false,
      agent: false,
      maxHeaderSize: 16 * 1_024,
    });
    expect(options).not.toHaveProperty("socketPath");
    expect(options).not.toHaveProperty("createConnection");
    expect(options).not.toHaveProperty("rejectUnauthorized");
    expect(options).not.toHaveProperty("servername");
    expect(runBoundLookup(options)).toEqual({ address: "8.8.8.8", family: 4 });

    connectRequest(http, "8.8.8.8", "connect");
    respond(http, 204);
    await expect(pending).resolves.toMatchObject({ kind: "response", status: 204 });
    expect(http.request.ended).toBe(true);
  });

  it("binds HTTPS to the approved IPv6 address while preserving ASCII Host, SNI, and TLS validation", async () => {
    const { http, https, request } = makeRequester();
    const destination = approvedDestination(
      "https://BÜCHER.DE./download?edition=deluxe#ignored",
      "2606:4700:4700:0000:0000:0000:0000:1111",
    );

    const pending = request(destination, "GET");
    const options = requireCapturedOptions(https);

    expect(http.calls).toBe(0);
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "xn--bcher-kva.de",
      port: 443,
      method: "GET",
      path: "/download?edition=deluxe",
      headers: { Host: "xn--bcher-kva.de" },
      family: 6,
      autoSelectFamily: false,
      agent: false,
      maxHeaderSize: 16 * 1_024,
      servername: "xn--bcher-kva.de",
      rejectUnauthorized: true,
    });
    expect(runBoundLookup(options)).toEqual({
      address: "2606:4700:4700::1111",
      family: 6,
    });
    expect(runBoundLookup(options, true)).toEqual({
      address: [{ address: "2606:4700:4700::1111", family: 6 }],
      family: undefined,
    });

    connectRequest(https, "2606:4700:4700::1111", "secureConnect");
    respond(https, 200);
    await expect(pending).resolves.toMatchObject({ kind: "response", status: 200 });
  });

  it("uses bracketed Host authority and no invented SNI name for an HTTPS IP literal", async () => {
    const { https, request } = makeRequester();
    const destination = approvedDestination(
      "https://[2606:4700:4700::1111]/release",
      "2606:4700:4700::1111",
    );

    const pending = request(destination, "HEAD");
    const options = requireCapturedOptions(https);

    expect(options.hostname).toBe("2606:4700:4700::1111");
    expect(options.headers).toEqual({ Host: "[2606:4700:4700::1111]" });
    expect(options).not.toHaveProperty("servername");
    expect(options).toMatchObject({ rejectUnauthorized: true, agent: false });

    connectRequest(https, "2606:4700:4700::1111", "secureConnect");
    respond(https, 200);
    await pending;
  });

  it("never needs an ambient resolver path when the adapter opens its bound request", async () => {
    const request = new FakeRequest();
    let callback: ((response: IncomingMessage) => void) | undefined;
    const factory: NodeRequestFactory = (options, onResponse) => {
      callback = onResponse;
      const bound = runBoundLookup(options);
      if (bound.address !== "1.1.1.1" || bound.family !== 4) {
        throw new Error("An uncontrolled resolver path would be required");
      }
      return request as unknown as ClientRequest;
    };
    const requestHeaders = createRequestHeaders({
      httpRequest: factory,
      httpsRequest: () => {
        throw new Error("Wrong protocol adapter");
      },
    });

    const pending = requestHeaders(
      approvedDestination("http://www.example.org/", "1.1.1.1"),
      "HEAD",
    );
    const socket = new FakeSocket("1.1.1.1");
    request.emit("socket", socket);
    socket.emit("connect");
    callback?.(new FakeResponse(200) as unknown as IncomingMessage);

    await expect(pending).resolves.toMatchObject({ kind: "response", status: 200 });
  });
});

describe("createRequestHeaders socket verification", () => {
  it.each([
    {
      label: "normalized IPv4",
      raw: "http://www.example.org/",
      selected: "8.8.8.8",
      remote: "8.8.8.8",
      event: "connect" as const,
      protocol: "http" as const,
    },
    {
      label: "expanded IPv6",
      raw: "https://www.example.org/",
      selected: "2606:4700:4700::1111",
      remote: "2606:4700:4700:0:0:0:0:1111",
      event: "secureConnect" as const,
      protocol: "https" as const,
    },
    {
      label: "IPv4-mapped IPv6",
      raw: "http://www.example.org/",
      selected: "8.8.8.8",
      remote: "::ffff:0808:0808",
      event: "connect" as const,
      protocol: "http" as const,
    },
  ])("accepts a semantically equal $label remote address", async (testCase) => {
    const requester = makeRequester();
    const destination = approvedDestination(testCase.raw, testCase.selected);
    const pending = requester.request(destination, "HEAD");
    const harness = requester[testCase.protocol];

    const socket = connectRequest(harness, testCase.remote, testCase.event);
    const response = respond(harness, 200);

    await expect(pending).resolves.toEqual({
      kind: "response",
      status: 200,
      locations: [],
      attempt: {
        method: "HEAD",
        url: testCase.raw,
        resolvedAddress: destination.selectedAddress.address,
        addressFamily: destination.selectedAddress.family,
        httpStatus: 200,
        startedAt: expect.any(Date),
        finishedAt: expect.any(Date),
      },
    });
    expect(response.destroyed).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it.each([undefined, "not-an-ip", "8.8.4.4"])(
    "fails closed and destroys the connection for mismatched remote address %s",
    async (remoteAddress) => {
      const startedAt = new Date("2026-09-04T10:00:00.000Z");
      const finishedAt = new Date("2026-09-04T10:00:00.010Z");
      const requester = makeRequester(
        requestHarness(),
        requestHarness(),
        vi.fn().mockReturnValueOnce(startedAt).mockReturnValueOnce(finishedAt),
      );
      const destination = approvedDestination(
        "http://www.example.org/private",
        "8.8.8.8",
      );
      const pending = requester.request(destination, "GET");

      const socket = connectRequest(requester.http, remoteAddress, "connect");

      await expect(pending).resolves.toEqual({
        kind: "failure",
        code: "unsafe_destination",
        attempt: {
          method: "GET",
          url: "http://www.example.org/private",
          resolvedAddress: "8.8.8.8",
          addressFamily: 4,
          httpStatus: null,
          startedAt,
          finishedAt,
        },
      });
      expect(socket.destroyed).toBe(true);
      expect(requester.http.request.destroyed).toBe(true);
    },
  );

  it("does not trust an HTTPS response until secureConnect validates the remote address", async () => {
    const requester = makeRequester();
    const pending = requester.request(
      approvedDestination("https://www.example.org/", "8.8.8.8"),
      "HEAD",
    );
    const socket = new FakeSocket("8.8.8.8");
    requester.https.request.emit("socket", socket);
    socket.emit("connect");

    const response = respond(requester.https, 200);

    await expect(pending).resolves.toMatchObject({
      kind: "failure",
      code: "unsafe_destination",
    });
    expect(response.destroyed).toBe(true);
    expect(socket.destroyed).toBe(true);
  });
});

describe("createRequestHeaders response boundary", () => {
  it("losslessly preserves every raw Location occurrence case-insensitively", async () => {
    const requester = makeRequester();
    const pending = requester.request(
      approvedDestination("https://www.example.org/start", "8.8.8.8"),
      "HEAD",
    );
    connectRequest(requester.https, "8.8.8.8", "secureConnect");
    const overlongLocation = `/${"x".repeat(2_048)}`;
    const response = new FakeResponse(302, [
      "Content-Type",
      "text/plain",
      "LOCATION",
      " /first ",
      "X-Trace",
      "ignored",
      "location",
      "https://redirect.example.org/second",
      "Location",
      "relative-third, relative-fourth",
      "lOcAtIoN",
      overlongLocation,
    ]);
    response.headers.location = "collapsed-value-that-must-not-be-used";
    const callback = requester.https.callback;
    if (callback === null) throw new Error("Missing response callback");

    callback(response as unknown as IncomingMessage);

    expect(response.destroyed).toBe(true);
    await expect(pending).resolves.toMatchObject({
      kind: "response",
      status: 302,
      locations: [
        " /first ",
        "https://redirect.example.org/second",
        "relative-third, relative-fourth",
        overlongLocation,
      ],
    });
  });

  it("destroys a GET response before emitted body data can be consumed or buffered", async () => {
    const requester = makeRequester();
    const pending = requester.request(
      approvedDestination("http://downloads.example.org/installer", "1.1.1.1"),
      "GET",
    );
    connectRequest(requester.http, "1.1.1.1", "connect");

    const response = respond(requester.http, 206, ["Content-Length", "104857600"]);
    expect(response.destroyed).toBe(true);
    expect(response.listenerCount("data")).toBe(0);
    response.emitBody("payload bytes that must stay unread");

    await expect(pending).resolves.toMatchObject({ kind: "response", status: 206 });
    expect(response.consumedBodyBytes).toBe(0);
    expect(response.listenerCount("data")).toBe(0);
  });

  it.each([undefined, Number.NaN, 200.5])(
    "maps a non-integer response status %s to a sanitized network failure",
    async (status) => {
      const requester = makeRequester();
      const pending = requester.request(
        approvedDestination("http://www.example.org/", "8.8.8.8"),
        "HEAD",
      );
      connectRequest(requester.http, "8.8.8.8", "connect");
      const response = respond(requester.http, status);

      await expect(pending).resolves.toMatchObject({
        kind: "failure",
        code: "network_error",
        attempt: { httpStatus: null },
      });
      expect(response.destroyed).toBe(true);
    },
  );
});

describe("createRequestHeaders deadlines and failures", () => {
  it("enforces the eight-second request-to-headers deadline and destroys request and socket", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-09-04T10:00:00.000Z");
    const finishedAt = new Date("2026-09-04T10:00:08.000Z");
    const requester = makeRequester(
      requestHarness(),
      requestHarness(),
      vi.fn().mockReturnValueOnce(startedAt).mockReturnValueOnce(finishedAt),
    );
    const destination = approvedDestination(
      "http://www.example.org/slow",
      "8.8.8.8",
    );
    const pending = requester.request(destination, "HEAD");
    const socket = connectRequest(requester.http, "8.8.8.8", "connect");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      kind: "failure",
      code: "timeout",
      attempt: {
        method: "HEAD",
        url: "http://www.example.org/slow",
        resolvedAddress: "8.8.8.8",
        addressFamily: 4,
        httpStatus: null,
        startedAt,
        finishedAt,
      },
    });
    expect(requester.http.request.destroyed).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it("caps an attempted deadline extension at eight seconds", async () => {
    vi.useFakeTimers();
    const requester = makeRequester();
    const pending = requester.request(
      approvedDestination("http://www.example.org/slow", "8.8.8.8"),
      "HEAD",
      { deadlineMs: 60_000 },
    );

    await vi.advanceTimersByTimeAsync(8_000);

    await expect(pending).resolves.toMatchObject({ kind: "failure", code: "timeout" });
  });

  it("lets a shorter positive deadline tighten the request bound", async () => {
    vi.useFakeTimers();
    const requester = makeRequester();
    const pending = requester.request(
      approvedDestination("http://www.example.org/slow", "8.8.8.8"),
      "HEAD",
      { deadlineMs: 250 },
    );

    await vi.advanceTimersByTimeAsync(249);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ kind: "failure", code: "timeout" });
  });

  it("maps in-flight cancellation to timeout and destroys request and socket", async () => {
    const requester = makeRequester();
    const controller = new AbortController();
    const pending = requester.request(
      approvedDestination("https://www.example.org/slow", "8.8.8.8"),
      "GET",
      { signal: controller.signal },
    );
    const socket = connectRequest(requester.https, "8.8.8.8", "secureConnect");

    controller.abort(new Error("sensitive abort reason"));

    await expect(pending).resolves.toMatchObject({
      kind: "failure",
      code: "timeout",
      attempt: { httpStatus: null },
    });
    expect(requester.https.request.destroyed).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it("does not create a request when the signal is already aborted", async () => {
    const requester = makeRequester();
    const controller = new AbortController();
    controller.abort();

    await expect(
      requester.request(
        approvedDestination("http://www.example.org/", "8.8.8.8"),
        "HEAD",
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ kind: "failure", code: "timeout" });
    expect(requester.http.calls).toBe(0);
    expect(requester.https.calls).toBe(0);
  });

  it("ignores a response arriving after timeout except to destroy it", async () => {
    vi.useFakeTimers();
    const requester = makeRequester();
    const pending = requester.request(
      approvedDestination("http://www.example.org/slow", "8.8.8.8"),
      "HEAD",
      { deadlineMs: 10 },
    );
    connectRequest(requester.http, "8.8.8.8", "connect");
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toMatchObject({ kind: "failure", code: "timeout" });

    const response = respond(requester.http, 200);
    expect(response.destroyed).toBe(true);
    await expect(pending).resolves.toMatchObject({ kind: "failure", code: "timeout" });
  });

  it.each([
    ["http", "ECONNREFUSED", "network_error"],
    ["https", "ECONNRESET", "network_error"],
    ["https", "ERR_TLS_CERT_ALTNAME_INVALID", "tls_error"],
    ["https", "CERT_HAS_EXPIRED", "tls_error"],
  ] as const)(
    "maps a %s %s request failure without exposing its error",
    async (protocol, errorCode, expectedCode) => {
      const requester = makeRequester();
      const pending = requester.request(
        approvedDestination(`${protocol}://www.example.org/`, "8.8.8.8"),
        "HEAD",
      );
      const harness = requester[protocol];
      const rawError = Object.assign(new Error("sensitive network detail"), {
        code: errorCode,
      });

      harness.request.emit("error", rawError);

      const result = await pending;
      expect(result).toMatchObject({
        kind: "failure",
        code: expectedCode,
        attempt: { httpStatus: null },
      });
      expect(result).not.toHaveProperty("error");
      expect(JSON.stringify(result)).not.toContain("sensitive network detail");
    },
  );

  it("maps an unexpected request close to network_error", async () => {
    const requester = makeRequester();
    const pending = requester.request(
      approvedDestination("http://www.example.org/", "8.8.8.8"),
      "HEAD",
    );

    requester.http.request.emit("close");

    await expect(pending).resolves.toMatchObject({
      kind: "failure",
      code: "network_error",
    });
  });

  it("sanitizes a synchronous request factory exception", async () => {
    const requestHeaders = createRequestHeaders({
      httpRequest: () => {
        throw new Error("sensitive adapter detail");
      },
      httpsRequest: () => {
        throw new Error("unused");
      },
    });

    const result = await requestHeaders(
      approvedDestination("http://www.example.org/", "8.8.8.8"),
      "HEAD",
    );

    expect(result).toMatchObject({ kind: "failure", code: "network_error" });
    expect(JSON.stringify(result)).not.toContain("sensitive adapter detail");
  });
});
