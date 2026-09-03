import { describe, expect, it, vi } from "vitest";
import { createSteamSearchClient } from "./client";

describe("Steam search HTTP client", () => {
  it("requests the Steam search endpoint and returns the uninspected JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = createSteamSearchClient({ fetch: fetchMock });

    const result = await client.search("elden ring");
    const [request, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(request));

    expect(url.pathname).toBe("/api/storesearch/");
    expect(url.searchParams.get("term")).toBe("elden ring");
    expect(url.searchParams.get("l")).toBe("english");
    expect(url.searchParams.get("cc")).toBe("US");
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.has("count")).toBe(false);
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.body).toEqual({ items: [] });
  });

  it("preserves Unicode search text in the request URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const client = createSteamSearchClient({ fetch: fetchMock });

    await client.search("黑神话：悟空");

    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get("term")).toBe("黑神话：悟空");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, "rate_limited", true],
    [500, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [400, "http_error", false],
    [404, "http_error", false],
  ] as const)("maps HTTP %s to %s", async (status, code, retryable) => {
    const client = createSteamSearchClient({
      fetch: vi.fn().mockResolvedValue(new Response("", {
        status,
        headers: status === 429 ? { "Retry-After": "30" } : undefined,
      })),
    });

    await expect(client.search("elden ring")).rejects.toMatchObject({
      code,
      retryable,
      status,
      ...(status === 429 ? { retryAfter: "30" } : {}),
    });
  });

  it("maps rejected fetches to retryable network errors", async () => {
    const client = createSteamSearchClient({
      fetch: vi.fn().mockRejectedValue(new TypeError("network down")),
    });

    await expect(client.search("elden ring")).rejects.toMatchObject({
      code: "network_error",
      retryable: true,
      cause: expect.any(TypeError),
    });
  });

  it("maps invalid JSON to a non-retryable malformed response error", async () => {
    const client = createSteamSearchClient({
      fetch: vi.fn().mockResolvedValue(new Response("not JSON", { status: 200 })),
    });

    await expect(client.search("elden ring")).rejects.toMatchObject({
      code: "malformed_json",
      retryable: false,
      cause: expect.any(Error),
    });
  });

  it("maps an aborted request to a retryable timeout", async () => {
    const client = createSteamSearchClient({
      timeoutMs: 1,
      fetch: vi.fn().mockImplementation((_input: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })),
    });

    await expect(client.search("elden ring")).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      cause: expect.objectContaining({ name: "AbortError" }),
    });
  });

  it("keeps the deadline active while consuming a JSON response body", async () => {
    const client = createSteamSearchClient({
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

    await expect(client.search("elden ring")).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      cause: expect.objectContaining({ name: "AbortError" }),
    });
  });
});
