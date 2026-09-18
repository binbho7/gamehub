import { randomUUID } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifierServer } from "./server";
import { signVerifierRequest, verifyVerifierResponse } from "../../lib/verifiers/official-links/remote/mac";
import { MAX_REQUEST_BYTES, VERIFIER_PATH } from "../../lib/verifiers/official-links/remote/types";
import type { OfficialLinkVerificationTransport } from "../../lib/verifiers/official-links/verification-transport";

const secret = "a".repeat(64);
const nowMs = () => 1000;
const terminal = { code: "invalid_url" as const, attempts: [], redirectChain: [], finalUrl: null, httpStatus: null, checkedAt: new Date(1000) };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function start(transport: OfficialLinkVerificationTransport = { verify: async () => terminal }) {
  const server = createVerifierServer({ secret, transport, nowMs });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}
async function signed(bodyOverrides = {}, raw?: string, timestamp = 1000) {
  const requestId = randomUUID();
  const body = new TextEncoder().encode(raw ?? JSON.stringify({ version: 1, operation: "verify_official_link", requestId, exactUrl: "bad", budgetMs: 1000, ...bodyOverrides }));
  const mac = await signVerifierRequest(secret, body, requestId, timestamp);
  return { body, requestId, headers: { "Content-Type": "application/json", "X-GameHub-Request-Id": mac.requestId, "X-GameHub-Timestamp": mac.timestampMs, "X-GameHub-Mac": mac.mac } };
}
async function expectSigned(response: Response, input: Awaited<ReturnType<typeof signed>>) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect(await verifyVerifierResponse(secret, input.body, input.requestId, response.status, bytes, response.headers.get("X-GameHub-Mac") ?? "")).toBe(true);
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("private Node verifier HTTP boundary", () => {
  it("rejects invalid MAC before invoking target transport", async () => {
    const verify = vi.fn();
    const origin = await start({ verify });
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["wrong MAC", "stale timestamp", "body tampering"])("rejects %s without target work", async kind => {
    const verify = vi.fn();
    const origin = await start({ verify });
    const input = await signed({}, undefined, kind === "stale timestamp" ? 32001 : 1000);
    if (kind === "wrong MAC") input.headers["X-GameHub-Mac"] = "0".repeat(64);
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", headers: input.headers, body: kind === "body tampering" ? "{}" : input.body });
    expect(response.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });
  it("signs completed responses and passes only URL, remaining budget and abort signal", async () => {
    const verify = vi.fn(async () => terminal);
    const origin = await start({ verify });
    const input = await signed();
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", ...input });
    expect(response.status).toBe(200);
    expect(await expectSigned(response, input)).toMatchObject({ version: 1, requestId: input.requestId, status: "completed", outcome: { code: "invalid_url" } });
    expect(verify).toHaveBeenCalledWith("bad", { linkDeadlineMs: 1000, signal: expect.any(AbortSignal) });
  });
  it.each(["method", "headers", "body", "dns", "ip", "tls", "version", "operation", "requestId"])("rejects request-supplied %s in signed error", async key => {
    const verify = vi.fn();
    const origin = await start({ verify });
    const input = await signed({ [key]: "override" });
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", ...input });
    expect(response.status).toBe(400);
    expect(await expectSigned(response, input)).toMatchObject({ status: "failed" });
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["{", '{"version":1,"version":1}', "[]"])("signs invalid JSON/schema error for %s", async raw => {
    const origin = await start();
    const input = await signed({}, raw);
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", ...input });
    expect(response.status).toBe(400);
    expect(await expectSigned(response, input)).toMatchObject({ status: "failed" });
  });
  it.each([VERIFIER_PATH + "?x=1", VERIFIER_PATH + "/", "/proxy"])("rejects path variant %s after authentication", async path => {
    const verify = vi.fn();
    const origin = await start({ verify });
    const input = await signed();
    const response = await fetch(origin + path, { method: "POST", ...input });
    expect(response.status).toBe(404);
    await expectSigned(response, input);
    expect(verify).not.toHaveBeenCalled();
  });
  it("rejects a non-POST method with a signed response", async () => {
    const origin = await start();
    const input = await signed();
    const response = await fetch(origin + VERIFIER_PATH, { method: "PUT", ...input });
    expect(response.status).toBe(405);
    await expectSigned(response, input);
  });
  it("rejects compression before target work", async () => {
    const verify = vi.fn();
    const origin = await start({ verify });
    const input = await signed();
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", body: input.body, headers: { ...input.headers, "Content-Encoding": "gzip" } });
    expect(response.status).toBe(400);
    await expectSigned(response, input);
    expect(verify).not.toHaveBeenCalled();
  });
  it("counts chunked bytes and rejects oversized body without target work", async () => {
    const verify = vi.fn();
    const origin = await start({ verify });
    const input = await signed({}, "x".repeat(MAX_REQUEST_BYTES + 1));
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(origin + VERIFIER_PATH, { method: "POST", headers: input.headers }, response => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
      request.write(input.body.slice(0, 8192));
      request.end(input.body.slice(8192));
    });
    expect(status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });
  it("returns a signed busy error while one target operation is active", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const origin = await start({ verify: async () => { entered(); await wait; return terminal; } });
    const first = await signed();
    const pending = fetch(origin + VERIFIER_PATH, { method: "POST", ...first });
    await ready;
    const second = await signed();
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", ...second });
    expect(response.status).toBe(503);
    expect(await expectSigned(response, second)).toMatchObject({ status: "failed", error: { code: "verifier_service_unavailable" } });
    release();
    expect((await pending).status).toBe(200);
  });
  it("sanitizes and signs unexpected transport errors", async () => {
    const origin = await start({ verify: async () => { throw new Error("secret-target-details"); } });
    const input = await signed();
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", ...input });
    expect(response.status).toBe(503);
    const payload = await expectSigned(response, input);
    expect(payload).toMatchObject({ status: "failed", error: { code: "verifier_service_unavailable" } });
    expect(JSON.stringify(payload)).not.toContain("secret-target-details");
  });
  it("aborts target work on authenticated client disconnect", async () => {
    let entered!: () => void;
    let aborted!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { aborted = resolve; });
    const origin = await start({ verify: async (_, options) => { entered(); await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => { aborted(); resolve(); }, { once: true })); return terminal; } });
    const input = await signed();
    const request = httpRequest(origin + VERIFIER_PATH, { method: "POST", headers: input.headers });
    request.on("error", () => {});
    request.end(input.body);
    await ready;
    request.destroy();
    await stopped;
  });
  it("aborts target work at the request budget and signs timeout", async () => {
    let aborted = false;
    const origin = await start({ verify: (_, options) => new Promise(resolve => { options?.signal?.addEventListener("abort", () => { aborted = true; resolve(terminal); }); }) });
    const input = await signed({ budgetMs: 20 });
    const response = await fetch(origin + VERIFIER_PATH, { method: "POST", ...input });
    expect(response.status).toBe(503);
    expect(await expectSigned(response, input)).toMatchObject({ error: { code: "verifier_timeout" } });
    expect(aborted).toBe(true);
  });
});
