import { afterEach, expect, it, vi } from "vitest";
import { createRemoteVerifierTransport } from "./client";
import { parseVerifierRequest } from "./codec";
import { signVerifierResponse, verifyVerifierRequest } from "./mac";
const secret = "a".repeat(64), id = "11111111-1111-4111-8111-111111111111";
afterEach(() => vi.useRealTimers());

async function reply(request: Request, change: { status?: number; headers?: Record<string, string>; body?: string } = {}) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const parsed = parseVerifierRequest(bytes);
  const body = new TextEncoder().encode(change.body ?? JSON.stringify({ version: 1, requestId: parsed.requestId, status: "completed", outcome: { code: "invalid_url", attempts: [], redirectChain: [], finalUrl: null, httpStatus: null, checkedAtMs: Date.now() } }));
  const status = change.status ?? 200;
  return new Response(body, { status, headers: { "Content-Type": "application/json", "X-GameHub-Mac": await signVerifierResponse(secret, bytes, parsed.requestId, status, body), ...change.headers } });
}
function client(fetch: (request: Request) => Promise<Response>, start: (timeout: number) => Promise<void> = async () => {}, nowMs = () => Date.now()) {
  return createRemoteVerifierTransport({ binding: { start, fetch }, secret, nowMs, newRequestId: () => id });
}
it("starts within the link budget then signs a reduced budget for a fixed private request", async () => {
  let now = 100000;
  const transport = client(async request => {
    expect(request.url).toBe("http://official-link-verifier/internal/v1/official-links/verify");
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    expect(parseVerifierRequest(bytes)).toMatchObject({ exactUrl: "bad url", budgetMs: 17000 });
    expect(await verifyVerifierRequest(secret, bytes, { requestId: request.headers.get("X-GameHub-Request-Id")!, timestampMs: request.headers.get("X-GameHub-Timestamp")!, mac: request.headers.get("X-GameHub-Mac")! }, now)).toBe(true);
    return reply(request);
  }, async timeout => { expect(timeout).toBe(10000); now += 3000; }, () => now);
  await expect(transport.verify("bad url")).resolves.toMatchObject({ code: "invalid_url" });
});
it("returns native local invalid_url and pre-abort timeout without RPC", async () => {
  const fetch = vi.fn(), start = vi.fn();
  const transport = client(fetch, start);
  for (const url of ["", "x".repeat(2049)]) await expect(transport.verify(url)).resolves.toMatchObject({ code: "invalid_url", attempts: [] });
  const abort = new AbortController(); abort.abort();
  await expect(transport.verify("bad url", { signal: abort.signal })).resolves.toMatchObject({ code: "timeout" });
  expect(start).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it("maps status, envelope, encoding and MAC failures to fixed service errors", async () => {
  const cases: Array<[Parameters<typeof reply>[1], string]> = [
    [{ status: 503 }, "verifier_service_unavailable"], [{ status: 401 }, "verifier_auth_error"], [{ status: 403 }, "verifier_auth_error"],
    [{ status: 405 }, "verifier_protocol_error"], [{ status: 302 }, "verifier_protocol_error"],
    [{ headers: { "Content-Type": "text/html" } }, "verifier_protocol_error"],
    [{ headers: { "Content-Encoding": "gzip" } }, "verifier_protocol_error"],
    [{ headers: { "X-GameHub-Mac": "0".repeat(64) } }, "verifier_auth_error"],
    [{ body: "{}" }, "verifier_protocol_error"], [{ body: "{" }, "verifier_invalid_response"],
    [{ body: "x".repeat(262145) }, "verifier_invalid_response"],
  ];
  for (const [change, code] of cases) await expect(client(request => reply(request, change)).verify("bad url")).rejects.toMatchObject({ code });
  await expect(client(async () => { throw new Error("secret"); }).verify("bad url")).rejects.toMatchObject({ code: "verifier_service_unavailable" });
  await expect(client(async request => reply(request), async () => { throw new Error("secret"); }).verify("bad url")).rejects.toMatchObject({ code: "verifier_service_unavailable" });
});
it("bounds startup, hanging delivery and response streaming under one deadline", async () => {
  vi.useFakeTimers();
  for (const mode of ["startup", "delivery", "stream"] as const) {
    let signal: AbortSignal | undefined;
    const transport = client(async request => { signal = request.signal; return mode === "delivery" ? new Promise(() => {}) : new Response(new ReadableStream(), { headers: { "Content-Type": "application/json", "X-GameHub-Mac": "0".repeat(64) } }); }, mode === "startup" ? async () => new Promise(() => {}) : undefined);
    const assertion = expect(transport.verify("bad url", { linkDeadlineMs: 100 })).rejects.toMatchObject({ code: "verifier_timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    if (signal) expect(signal.aborted).toBe(true);
  }
});

it("cancels a late response without accepting observations after the delivery deadline", async () => {
  vi.useFakeTimers();
  let deliver: (response: Response) => void = () => {};
  let started = false;
  let cancelled = false;
  const transport = client(async () => new Promise(resolve => { deliver = resolve; started = true; }));
  const assertion = expect(transport.verify("bad url", { linkDeadlineMs: 100 })).rejects.toMatchObject({ code: "verifier_timeout" });
  await vi.advanceTimersByTimeAsync(10);
  // WebCrypto is real asynchronous work even when timers are controlled.
  await vi.waitFor(() => expect(started).toBe(true));
  await vi.advanceTimersByTimeAsync(100);
  await assertion;
  deliver(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(cancelled).toBe(true);
});
