import { describe, expect, it, vi } from "vitest";
import { createIgdbClient } from "./client";

const clientId = "fake-igdb-client-id";
const firstAccessToken = "fake-igdb-access-token-do-not-print";
const replacementAccessToken = "fake-replacement-access-token-do-not-print";
const query = "fields id,name; where id = 7; limit 1;";

function createClient(overrides: Partial<Parameters<typeof createIgdbClient>[0]> = {}) {
  return createIgdbClient({
    auth: {
      getAccessToken: vi.fn().mockResolvedValue(firstAccessToken),
      invalidateAccessToken: vi.fn(),
    },
    clientId,
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 7, name: "Example" }]), { status: 200 })),
    now: () => new Date("2026-09-03T00:00:00Z"),
    ...overrides,
  });
}

function recursivelyCollectedStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return [];
  }

  seen.add(value);
  return Reflect.ownKeys(value).flatMap((key) => {
    try {
      return recursivelyCollectedStrings(Reflect.get(value, key), seen);
    } catch {
      return [];
    }
  });
}

function expectSanitized(error: unknown) {
  const candidate = error as Error & { details?: unknown };
  const inspected = recursivelyCollectedStrings(candidate).join(" ");

  for (const secret of [clientId, firstAccessToken, replacementAccessToken, query]) {
    expect(candidate.name).not.toContain(secret);
    expect(candidate.message).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(inspected).not.toContain(secret);
  }
}

describe("IGDB HTTP client", () => {
  it("posts the plain APICalypse query to the requested IGDB endpoint and returns uninspected JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ id: 7, name: "Example" }]), {
      status: 200,
    }));
    const client = createClient({ fetch: fetchMock });

    await expect(client.request("external_games", query)).resolves.toEqual({
      body: [{ id: 7, name: "Example" }],
      fetchedAt: new Date("2026-09-03T00:00:00Z"),
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(String(url)).toBe("https://api.igdb.com/v4/external_games");
    expect(init.method).toBe("POST");
    expect(headers.get("Client-ID")).toBe(clientId);
    expect(headers.get("Authorization")).toBe(`Bearer ${firstAccessToken}`);
    expect(headers.get("Accept")).toBe("application/json");
    expect(init.body).toBe(query);
  });

  it("uses the whitelisted games endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    const client = createClient({ fetch: fetchMock });

    await client.request("games", query);

    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.igdb.com/v4/games");
  });

  it("rejects a cast endpoint before it can acquire a token or send an authenticated request", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue(firstAccessToken),
      invalidateAccessToken: vi.fn(),
    };
    const fetchMock = vi.fn();
    const client = createClient({ auth, fetch: fetchMock });
    const invalidEndpoint = "https://untrusted.example.test/endpoint";

    const error = await client.request(invalidEndpoint as "games", query).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "http_error", retryable: false });
    expect((error as Error).message).not.toContain(invalidEndpoint);
    expect(auth.getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expectSanitized(error);
  });

  it("times out while JSON body parsing is still pending", async () => {
    let responseSignal: AbortSignal | undefined;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: vi.fn(() => new Promise((_resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error("body deadline was not enforced")), 50);
        responseSignal?.addEventListener("abort", () => {
          clearTimeout(fallback);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      })),
    } as unknown as Response;
    const client = createClient({
      timeoutMs: 1,
      fetch: vi.fn().mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
        responseSignal = init?.signal ?? undefined;
        return Promise.resolve(response);
      }),
    });

    const error = await client.request("games", query).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "timeout", retryable: true });
    expectSanitized(error);
  });

  it("maps rejected network requests without exposing sensitive request data", async () => {
    const rawFailure = Object.assign(
      new Error(`request failed for ${firstAccessToken}`),
      { request: { headers: { Authorization: `Bearer ${firstAccessToken}`, "Client-ID": clientId }, body: query } },
    );
    const fetchMock = vi.fn().mockRejectedValue(rawFailure);
    const client = createClient({ fetch: fetchMock });

    const error = await client.request("games", query).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "network_error", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectSanitized(error);
  });

  it("classifies a forbidden response before attempting JSON parsing", async () => {
    const response = {
      ok: false,
      status: 403,
      headers: new Headers(),
      json: vi.fn(),
    } as unknown as Response;
    const client = createClient({ fetch: vi.fn().mockResolvedValue(response) });

    const error = await client.request("games", query).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "http_error", retryable: false, status: 403 });
    expect(response.json).not.toHaveBeenCalled();
    expectSanitized(error);
  });

  it.each([
    [429, "rate_limited", true, "30"],
    [404, "http_error", false, undefined],
    [503, "provider_unavailable", true, undefined],
  ] as const)("classifies HTTP %s without a general retry", async (status, code, retryable, retryAfter) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status,
      headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
    }));
    const client = createClient({ fetch: fetchMock });

    const error = await client.request("games", query).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code, retryable, status, ...(retryAfter ? { retryAfter } : {}) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectSanitized(error);
  });

  it("maps malformed JSON without exposing the provider response", async () => {
    const rawFailure = Object.assign(
      new Error(`invalid JSON for ${firstAccessToken}`),
      { response: { body: query, authorization: `Bearer ${firstAccessToken}` } },
    );
    const client = createClient({ fetch: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.reject(rawFailure),
    } as Response) });

    const error = await client.request("games", query).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "malformed_json", retryable: false });
    expectSanitized(error);
  });

  it("invalidates a rejected token and retries a 401 request exactly once", async () => {
    const auth = {
      getAccessToken: vi.fn()
        .mockResolvedValueOnce(firstAccessToken)
        .mockResolvedValueOnce(replacementAccessToken),
      invalidateAccessToken: vi.fn(),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const client = createClient({ auth, fetch: fetchMock });

    await expect(client.request("games", query)).resolves.toEqual({
      body: [],
      fetchedAt: new Date("2026-09-03T00:00:00Z"),
    });

    expect(auth.invalidateAccessToken).toHaveBeenCalledTimes(1);
    expect(auth.getAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]![1].headers).get("Authorization")).toBe(
      `Bearer ${replacementAccessToken}`,
    );
  });

  it("fails authentication after a second 401 without another retry", async () => {
    const auth = {
      getAccessToken: vi.fn()
        .mockResolvedValueOnce(firstAccessToken)
        .mockResolvedValueOnce(replacementAccessToken),
      invalidateAccessToken: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const client = createClient({ auth, fetch: fetchMock });

    const error = await client.request("games", query).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "authentication_failed", retryable: false, status: 401 });
    expect(auth.invalidateAccessToken).toHaveBeenCalledTimes(1);
    expect(auth.getAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectSanitized(error);
  });
});
