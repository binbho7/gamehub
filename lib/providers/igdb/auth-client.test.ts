import { describe, expect, it, vi } from "vitest";
import { createIgdbAuthClient } from "./auth-client";

const clientId = "fake-twitch-client-id";
const clientSecret = "fake-twitch-secret-do-not-print";
const accessToken = "fake-twitch-access-token-do-not-print";

function successResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    access_token: accessToken,
    expires_in: 3600,
    token_type: "bearer",
    ...overrides,
  }), { status: 200 });
}

function createAuth(overrides: Parameters<typeof createIgdbAuthClient>[0] = {}) {
  return createIgdbAuthClient({
    clientId,
    clientSecret,
    fetch: vi.fn().mockResolvedValue(successResponse()),
    now: () => 1_000,
    ...overrides,
  });
}

function expectSanitized(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  const candidate = error as Error & { details?: unknown };
  const publicDetails = Object.entries(candidate).flatMap(([key, value]) => [key, JSON.stringify(value)]);
  const formatted = JSON.stringify(error);

  for (const secret of [clientSecret, accessToken]) {
    expect(candidate.name).not.toContain(secret);
    expect(candidate.message).not.toContain(secret);
    expect(publicDetails.join(" ")).not.toContain(secret);
    expect(formatted).not.toContain(secret);
  }
}

describe("IGDB Twitch auth client", () => {
  it("rejects missing credentials without calling Twitch or exposing configuration", async () => {
    const fetchMock = vi.fn();
    const auth = createIgdbAuthClient({ fetch: fetchMock });

    const error = await auth.getAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "missing_credentials", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expectSanitized(error);
  });

  it("sends the exact form-encoded client-credentials request and returns the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successResponse());
    const auth = createAuth({ fetch: fetchMock, tokenUrl: "https://twitch.example.test/oauth2/token" });

    await expect(auth.getAccessToken()).resolves.toBe(accessToken);

    expect(fetchMock).toHaveBeenCalledWith("https://twitch.example.test/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id=fake-twitch-client-id&client_secret=fake-twitch-secret-do-not-print&grant_type=client_credentials",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects a token response that does not match the consumed OAuth schema", async () => {
    const auth = createAuth({ fetch: vi.fn().mockResolvedValue(successResponse({ expires_in: "3600" })) });

    const error = await auth.getAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "schema_changed", retryable: false });
    expectSanitized(error);
  });

  it("classifies invalid Twitch credentials without exposing the request body", async () => {
    const auth = createAuth({ fetch: vi.fn().mockResolvedValue(new Response(null, { status: 401 })) });

    const error = await auth.getAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "invalid_credentials", retryable: false, status: 401 });
    expectSanitized(error);
  });

  it.each([
    [429, "rate_limited", true],
    [503, "provider_unavailable", true],
    [404, "http_error", false],
  ] as const)("classifies Twitch HTTP %s as %s", async (status, code, retryable) => {
    const auth = createAuth({ fetch: vi.fn().mockResolvedValue(new Response(null, {
      status,
      headers: { "Retry-After": "30" },
    })) });

    const error = await auth.getAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code, retryable, status });
    expect((error as { retryAfter?: string }).retryAfter).toBe(status === 429 ? "30" : "30");
    expectSanitized(error);
  });

  it("classifies a rejected token request as a retryable network failure", async () => {
    const auth = createAuth({ fetch: vi.fn().mockRejectedValue(new TypeError("network down")) });

    const error = await auth.getAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "network_error", retryable: true });
    expectSanitized(error);
  });

  it("times out while waiting for the token response", async () => {
    const auth = createAuth({
      timeoutMs: 1,
      fetch: vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })),
    });

    const error = await auth.getAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expectSanitized(error);
  });

  it("keeps the deadline active while response.json is pending", async () => {
    const response = {
      ok: true,
      json: vi.fn(() => new Promise((_resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error("body deadline was not enforced")), 50);
        // The client must pass the same deadline signal to the request, which this
        // fetch double observes before resolving its response.
        responseSignal?.addEventListener("abort", () => {
          clearTimeout(fallback);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })),
      status: 200,
      headers: new Headers(),
    } as unknown as Response;
    let responseSignal: AbortSignal | undefined;
    const auth = createAuth({
      timeoutMs: 1,
      fetch: vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
        responseSignal = init?.signal ?? undefined;
        return Promise.resolve(response);
      }),
    });

    const error = await auth.getAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expectSanitized(error);
  });

  it("classifies malformed JSON without exposing a token-shaped response", async () => {
    const auth = createAuth({ fetch: vi.fn().mockResolvedValue(new Response("not JSON", { status: 200 })) });

    const error = await auth.getAccessToken().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "malformed_json", retryable: false });
    expectSanitized(error);
  });

  it("reuses a cached token until its expiry margin", async () => {
    let now = 1_000;
    const fetchMock = vi.fn().mockResolvedValue(successResponse({ expires_in: 120 }));
    const auth = createAuth({ fetch: fetchMock, now: () => now });

    await expect(auth.getAccessToken()).resolves.toBe(accessToken);
    now = 59_999;
    await expect(auth.getAccessToken()).resolves.toBe(accessToken);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes at the safety margin before the provider expiry", async () => {
    let now = 1_000;
    const secondToken = "second-token";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(successResponse({ expires_in: 120 }))
      .mockResolvedValueOnce(successResponse({ access_token: secondToken, expires_in: 120 }));
    const auth = createAuth({ fetch: fetchMock, now: () => now, expiryMarginMs: 60_000 });

    await expect(auth.getAccessToken()).resolves.toBe(accessToken);
    now = 61_000;
    await expect(auth.getAccessToken()).resolves.toBe(secondToken);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches a new token after explicit invalidation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(successResponse({ access_token: "replacement-token" }));
    const auth = createAuth({ fetch: fetchMock });

    await auth.getAccessToken();
    auth.invalidateAccessToken();
    await expect(auth.getAccessToken()).resolves.toBe("replacement-token");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears a rejected single-flight request so a later caller can retry", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(successResponse());
    const auth = createAuth({ fetch: fetchMock });

    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "network_error" });
    await expect(auth.getAccessToken()).resolves.toBe(accessToken);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight token request between concurrent callers", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const auth = createAuth({ fetch: fetchMock });

    const first = auth.getAccessToken();
    const second = auth.getAccessToken();
    resolveFetch?.(successResponse());

    await expect(Promise.all([first, second])).resolves.toEqual([accessToken, accessToken]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
