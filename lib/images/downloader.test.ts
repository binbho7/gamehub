import { describe, expect, it, vi } from "vitest";

import {
  downloadImageSource,
  type DownloadRequest,
} from "./downloader";
import type { ImageCandidate } from "./candidates";
import type { Clock, TimerHandle } from "./clock";

const START = "https://cdn.akamai.steamstatic.com/steam/apps/10/start.jpg";
const TARGET = "https://cdn.akamai.steamstatic.com/steam/apps/10/final.jpg";
const MAX_BYTES = 8_388_608;

function candidate(sourceUrl = START): ImageCandidate {
  return {
    gameId: 10,
    type: "cover",
    sourceUrl,
    provider: "steam",
    width: null,
    height: null,
    sortOrder: 0,
    existingId: null,
  };
}

function body(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel: onCancel,
  });
}

function response(
  status: number,
  options: { headers?: Record<string, string>; body?: ReadableStream<Uint8Array> } = {},
): Response {
  return new Response(options.body ?? null, { status, headers: options.headers });
}

function request(
  fetchImpl: typeof fetch,
  options: Partial<DownloadRequest> = {},
): DownloadRequest {
  return {
    candidate: candidate(),
    fetchImpl,
    signal: new AbortController().signal,
    now: () => 0,
    ...options,
  };
}

function controlledClock(): { clock: Clock; fireNext(): void; delays: number[] } {
  const callbacks = new Map<number, () => void>();
  const delays: number[] = [];
  let nextHandle = 0;
  return {
    delays,
    clock: {
      now: () => 0,
      setTimeout(callback, delayMs) {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        delays.push(delayMs);
        return handle as unknown as TimerHandle;
      },
      clearTimeout(handle) {
        callbacks.delete(handle as unknown as number);
      },
    },
    fireNext() {
      const first = callbacks.entries().next().value as [number, () => void] | undefined;
      if (first !== undefined) callbacks.delete(first[0]);
      const callback = first?.[1];
      if (callback === undefined) throw new Error("No deadline was scheduled");
      callback();
    },
  };
}

describe("downloadImageSource", () => {
  async function withFallback<T>(promise: Promise<T>): Promise<T | "hung"> {
    return Promise.race([
      promise,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
    ]);
  }

  async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }

  it.each([301, 302, 303, 307, 308])("follows manual GET redirect %i and cancels its body", async (status) => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(status, {
        headers: { Location: "/steam/apps/10/final.jpg" },
        body: body([new Uint8Array([1])], cancel),
      }))
      .mockResolvedValueOnce(response(200, {
        headers: { "Content-Type": "image/jpeg" },
        body: body([new Uint8Array([1, 2, 3])]),
      }));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "downloaded",
      finalUrl: TARGET,
      httpStatus: 200,
      contentType: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]),
      errorCode: null,
      attempts: [
        { url: START, status, location: "/steam/apps/10/final.jpg" },
        { url: TARGET, status: 200, location: null },
      ],
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    }
  });

  it("does not follow a non-redirect 3xx response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(304, {
      headers: { "Content-Type": "text/plain" },
    }));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "download_failed",
      httpStatus: 304,
      finalUrl: START,
      contentType: "text/plain",
      errorCode: "http_status",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("maps a fetch rejection to download_failed without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "download_failed",
      errorCode: "network_error",
      attempts: [{ url: START, status: null, location: null }],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", undefined],
    ["malformed", "http://["],
  ])("rejects a %s redirect Location", async (_label, location) => {
    const headers: Record<string, string> = location === undefined ? {} : { Location: location };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(302, { headers }));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "redirect_rejected",
      httpStatus: 302,
      finalUrl: null,
      errorCode: "invalid_location",
    });
  });

  it("rejects an oversized Location before URL normalization can shorten it", async () => {
    const location = `/${"segment/../".repeat(200)}steam/apps/10/final.jpg`;
    expect(location.length).toBeGreaterThan(2_048);
    expect(new URL(location, START).toString()).toBe(TARGET);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(302, {
      headers: { Location: location },
    }));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "redirect_rejected",
      httpStatus: 302,
      finalUrl: null,
      errorCode: "invalid_location",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not wait for a redirect body cancellation that ignores cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(302, {
        headers: { Location: TARGET },
        body: new ReadableStream({ cancel }),
      }))
      .mockResolvedValueOnce(response(200, {
        body: body([new Uint8Array([1])]),
      }));

    await expect(withFallback(downloadImageSource(request(fetchImpl)))).resolves.toMatchObject({
      outcome: "downloaded",
      finalUrl: TARGET,
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects redirect loops", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(302, { headers: { Location: TARGET } }))
      .mockResolvedValueOnce(response(302, { headers: { Location: START } }));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "redirect_rejected",
      errorCode: "redirect_loop",
      attempts: [
        { url: START, status: 302, location: TARGET },
        { url: TARGET, status: 302, location: START },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["cross-provider", "https://images.igdb.com/igdb/image/upload/t_cover_big/a.jpg"],
    ["downgrade", "http://cdn.akamai.steamstatic.com/steam/apps/10/final.jpg"],
  ])("rejects a %s redirect", async (_label, location) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(302, { headers: { Location: location } }));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "redirect_rejected",
      errorCode: "target_rejected",
      finalUrl: null,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("allows only three redirects and four total GET hops", async () => {
    const urls = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"].map((name) => (
      `https://cdn.akamai.steamstatic.com/steam/apps/10/${name}`
    ));
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(302, { headers: { Location: urls[0]! } }))
      .mockResolvedValueOnce(response(302, { headers: { Location: urls[1]! } }))
      .mockResolvedValueOnce(response(302, { headers: { Location: urls[2]! } }))
      .mockResolvedValueOnce(response(302, { headers: { Location: urls[3]! } }));

    const result = await downloadImageSource(request(fetchImpl));
    expect(result).toMatchObject({
      outcome: "redirect_rejected",
      errorCode: "redirect_limit",
    });
    expect(result.attempts).toContainEqual({ url: urls[2], status: 302, location: urls[3] });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("maps a response-header timeout to deadline", async () => {
    const { clock, fireNext } = controlledClock();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const downloading = downloadImageSource(request(fetchImpl, { clock }));
    fireNext();
    await expect(downloading).resolves.toMatchObject({ outcome: "deadline", errorCode: "header_timeout" });
  });

  it("resolves a header deadline even when fetch ignores abort", async () => {
    const { clock, fireNext } = controlledClock();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));

    const downloading = downloadImageSource(request(fetchImpl, { clock }));
    fireNext();
    await expect(withFallback(downloading)).resolves.toMatchObject({
      outcome: "deadline",
      errorCode: "header_timeout",
    });
  });

  it("maps a body/image timeout to deadline", async () => {
    const { clock, fireNext } = controlledClock();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => Promise.resolve(response(200, {
      body: new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
        },
      }),
    })));

    const downloading = downloadImageSource(request(fetchImpl, { clock }));
    await flushMicrotasks();
    fireNext();
    await expect(downloading).resolves.toMatchObject({ outcome: "deadline", errorCode: "body_timeout" });
  });

  it("uses the ten-second header deadline and thirty-second body budget", async () => {
    const controlled = controlledClock();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      body: body([new Uint8Array([1])]),
    }));

    await expect(downloadImageSource(request(fetchImpl, { clock: controlled.clock }))).resolves.toMatchObject({
      outcome: "downloaded",
    });
    expect(controlled.delays).toEqual([10_000, 30_000]);
  });

  it("shortens later hop deadlines instead of extending the image budget", async () => {
    let elapsed = 0;
    const controlled = controlledClock();
    controlled.clock.now = () => elapsed;
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      elapsed += 9_000;
      return Promise.resolve(url === START
        ? response(302, { headers: { Location: TARGET } })
        : response(200, { body: body([new Uint8Array([1])]) }));
    });

    await expect(downloadImageSource(request(fetchImpl, {
      clock: controlled.clock,
      now: () => elapsed,
    }))).resolves.toMatchObject({ outcome: "downloaded" });
    expect(controlled.delays).toEqual([10_000, 10_000, 12_000]);
  });

  it("caps a fourth hop header timer by the remaining image budget", async () => {
    let elapsed = 0;
    const controlled = controlledClock();
    controlled.clock.now = () => elapsed;
    const urls = ["a.jpg", "b.jpg", "c.jpg", "d.jpg"].map((name) => (
      `https://cdn.akamai.steamstatic.com/steam/apps/10/${name}`
    ));
    const fetchImpl = vi.fn<typeof fetch>((url) => {
      const index = urls.indexOf(String(url));
      elapsed += 7_000;
      return Promise.resolve(index < urls.length - 1
        ? response(302, { headers: { Location: urls[index + 1]! } })
        : response(200, { body: body([new Uint8Array([1])]) }));
    });

    await expect(downloadImageSource(request(fetchImpl, {
      candidate: candidate(urls[0]),
      clock: controlled.clock,
      now: () => elapsed,
    }))).resolves.toMatchObject({ outcome: "downloaded" });
    expect(controlled.delays).toEqual([10_000, 10_000, 10_000, 9_000, 2_000]);
  });

  it("canonicalizes the initial URL before detecting a self-redirect", async () => {
    const source = "HTTPS://CDN.AKAMAI.STEAMSTATIC.COM:443/steam/apps/10/start.jpg";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(302, {
      headers: { Location: START },
    }));

    await expect(downloadImageSource(request(fetchImpl, { candidate: candidate(source) }))).resolves.toMatchObject({
      outcome: "redirect_rejected",
      errorCode: "redirect_loop",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("resolves a body deadline even when the stream ignores abort", async () => {
    const { clock, fireNext } = controlledClock();
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(response(200, {
      body: new ReadableStream({ pull: () => new Promise<void>(() => undefined) }),
    })));

    const downloading = downloadImageSource(request(fetchImpl, { clock }));
    await flushMicrotasks();
    fireNext();
    await expect(withFallback(downloading)).resolves.toMatchObject({
      outcome: "deadline",
      errorCode: "body_timeout",
    });
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      headers: { "Content-Length": String(MAX_BYTES + 1) },
      body: body([new Uint8Array([1])], cancel),
    }));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "too_large",
      errorCode: "content_length",
      bytes: null,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("streams an un-sized body once and aborts when it exceeds the exact cap", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal;
      return Promise.resolve(response(200, {
        body: body([new Uint8Array(MAX_BYTES), new Uint8Array([1])]),
      }));
    });

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({
      outcome: "too_large",
      errorCode: "body_size",
      bytes: null,
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses no HEAD request or duplicate GET after a final response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(200, {
      body: body([new Uint8Array([9])]),
    }));

    await expect(downloadImageSource(request(fetchImpl))).resolves.toMatchObject({ outcome: "downloaded" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "manual" });
  });
});
