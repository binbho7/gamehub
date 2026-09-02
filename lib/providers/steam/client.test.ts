import { describe, expect, it, vi } from "vitest";
import { createSteamClient } from "./client";

describe("Steam HTTP client", () => {
  it("returns a success:false body without interpreting it", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      new Response('{"1245620":{"success":false}}', { status: 200 }),
    );
    const client = createSteamClient({
      fetch: fetchStub,
      now: () => new Date("2026-09-02T00:00:00Z"),
    });

    await expect(client.fetchAppDetails("1245620")).resolves.toEqual({
      body: { "1245620": { success: false } },
      fetchedAt: new Date("2026-09-02T00:00:00Z"),
      requestUrl: "https://store.steampowered.com/api/appdetails?appids=1245620&cc=us&l=english",
    });
  });

  it("sends the normalized app id and Steam locale query parameters", async () => {
    let requestedUrl: URL | undefined;
    const client = createSteamClient({
      baseUrl: "https://steam.example.test/appdetails?existing=value",
      fetch: vi.fn().mockImplementation((input: URL) => {
        requestedUrl = input;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }),
    });

    await client.fetchAppDetails("001245620");

    expect(requestedUrl?.toString()).toBe(
      "https://steam.example.test/appdetails?existing=value&appids=001245620&cc=us&l=english",
    );
  });

  it("classifies an aborted request as a retryable timeout", async () => {
    const client = createSteamClient({
      timeoutMs: 1,
      fetch: vi.fn().mockImplementation((_input: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })),
    });

    await expect(client.fetchAppDetails("1245620")).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  it("keeps the deadline active while consuming a streaming JSON body", async () => {
    const client = createSteamClient({
      timeoutMs: 5,
      fetch: vi.fn().mockImplementation((_input: URL, init?: RequestInit) => Promise.resolve(new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            const fallback = setTimeout(() => {
              controller.error(new Error("stream body was not aborted by the client deadline"));
            }, 50);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(fallback);
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        }),
        { status: 200 },
      ))),
    });

    await expect(client.fetchAppDetails("1245620")).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      cause: expect.objectContaining({ name: "AbortError" }),
    });
  });

  it("classifies rejected requests as retryable network errors", async () => {
    const client = createSteamClient({
      fetch: vi.fn().mockRejectedValue(new TypeError("network down")),
    });

    await expect(client.fetchAppDetails("1245620")).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
      cause: expect.any(TypeError),
    });
  });

  it("preserves retry-after metadata for rate limits", async () => {
    const client = createSteamClient({
      fetch: vi.fn().mockResolvedValue(new Response(null, {
        status: 429,
        headers: { "Retry-After": "30" },
      })),
    });

    await expect(client.fetchAppDetails("1245620")).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      status: 429,
      retryAfter: "30",
    });
  });

  it("classifies 503 responses as retryable provider failures", async () => {
    const client = createSteamClient({
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    });

    await expect(client.fetchAppDetails("1245620")).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      status: 503,
    });
  });

  it("classifies 404 responses as non-retryable HTTP errors", async () => {
    const client = createSteamClient({
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    });

    await expect(client.fetchAppDetails("1245620")).rejects.toMatchObject({
      code: "http_error",
      retryable: false,
      status: 404,
    });
  });

  it("classifies invalid JSON as a non-retryable response error", async () => {
    const client = createSteamClient({
      fetch: vi.fn().mockResolvedValue(new Response("not JSON", { status: 200 })),
    });

    await expect(client.fetchAppDetails("1245620")).rejects.toMatchObject({
      code: "malformed_json",
      retryable: false,
      cause: expect.any(Error),
    });
  });
});
