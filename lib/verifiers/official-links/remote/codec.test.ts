import { expect, it } from "vitest";
import { encodeVerifierOutcome, parseVerifierRequest, parseVerifierResponse, readVerifierBody } from "./codec";
import type { VerifierWireRequest } from "./types";
import { executeRedirectChain } from "../redirect";
import { verifyUrl } from "../verifier";
import type { VerificationCode } from "../types";

const id = "11111111-1111-4111-8111-111111111111";
const request: VerifierWireRequest = { version: 1, operation: "verify_official_link", requestId: id, exactUrl: "https://public.com/raw#fragment", budgetMs: 20000 };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const attempt = { method: "HEAD", url: request.exactUrl, resolvedAddress: "8.8.8.8", addressFamily: 4, httpStatus: 200, startedAtMs: 1, finishedAtMs: 2 };
const outcome = { code: "http_result", attempts: [attempt], redirectChain: [], finalUrl: request.exactUrl, httpStatus: 200, checkedAtMs: 3 };
const envelope = (changes = {}) => ({ version: 1, requestId: id, status: "completed", outcome: { ...outcome, ...changes } });

it("preserves exact URLs and converts dates only after a valid correlated observation", () => {
  expect(parseVerifierRequest(bytes(request))).toEqual(request);
  const parsed = parseVerifierResponse(bytes(envelope()), request);
  expect(parsed).toEqual({ code: "http_result", attempts: [{ method: "HEAD", url: request.exactUrl, resolvedAddress: "8.8.8.8", addressFamily: 4, httpStatus: 200, startedAt: new Date(1), finishedAt: new Date(2) }], redirectChain: [], finalUrl: request.exactUrl, httpStatus: 200, checkedAt: new Date(3) });
  expect(JSON.parse(new TextDecoder().decode(encodeVerifierOutcome(id, parsed)))).toEqual(envelope());
});

it("accepts malformed bounded request URLs for native verification but rejects protocol extensions", () => {
  expect(parseVerifierRequest(bytes({ ...request, exactUrl: "bad url" })).exactUrl).toBe("bad url");
  for (const change of [{ version: 2 }, { operation: "fetch" }]) expect(() => parseVerifierRequest(bytes({ ...request, ...change }))).toThrow(expect.objectContaining({ code: "verifier_protocol_error" }));
  for (const change of [{ body: "secret" }, { budgetMs: 0 }, { budgetMs: 20001 }, { requestId: "bad" }, { exactUrl: "x".repeat(2049) }]) expect(() => parseVerifierRequest(bytes({ ...request, ...change }))).toThrow(expect.objectContaining({ code: "verifier_invalid_response" }));
});

it("rejects duplicate keys including escaped nested names, invalid bytes and excessive depth", () => {
  for (const text of ['{"version":1,"version":1}', '{"a":{"x":1,"\\u0078":2}}', '['.repeat(100) + '0' + ']'.repeat(100), '{']) expect(() => parseVerifierRequest(new TextEncoder().encode(text))).toThrow(expect.objectContaining({ code: "verifier_invalid_response" }));
  expect(() => parseVerifierRequest(new Uint8Array([255]))).toThrow();
  expect(() => parseVerifierResponse(new Uint8Array(262145), request)).toThrow();
});

it("rejects unknown fields, enums, invalid times, addresses, status and impossible terminal layout", () => {
  for (const change of [
    { code: "safe" }, { body: "secret" }, { checkedAtMs: 8640000000000001 },
    { checkedAtMs: 1 }, { finalUrl: "https://different.com/" }, { httpStatus: null },
    { attempts: [] }, { attempts: [{ ...attempt, extra: 1 }] }, { attempts: [{ ...attempt, method: "POST" }] },
    { attempts: [{ ...attempt, finishedAtMs: 0 }] }, { attempts: [{ ...attempt, httpStatus: 600 }] },
    { attempts: [{ ...attempt, addressFamily: 6 }] }, { attempts: [{ ...attempt, resolvedAddress: "hello" }] },
    { attempts: Array(13).fill(attempt) }, { redirectChain: Array(7).fill({}) },
  ]) expect(() => parseVerifierResponse(bytes(envelope(change)), request)).toThrow(expect.objectContaining({ code: "verifier_invalid_response" }));
  expect(() => parseVerifierResponse(bytes({ ...envelope(), requestId: "22222222-2222-4222-8222-222222222222" }), request)).toThrow();
});

it("accepts GET restart and timeout retaining only the completed HEAD block", () => {
  const head = { ...attempt, httpStatus: 405 };
  expect(parseVerifierResponse(bytes(envelope({ attempts: [head, { ...attempt, method: "GET", startedAtMs: 2, finishedAtMs: 3 }] })), request).attempts.map(a => a.method)).toEqual(["HEAD", "GET"]);
  expect(parseVerifierResponse(bytes(envelope({ code: "timeout", attempts: [head], finalUrl: null, httpStatus: null })), request).code).toBe("timeout");
  for (const attempts of [[{ ...attempt, method: "GET" }], [attempt, { ...attempt, method: "GET" }], [head, { ...attempt, method: "GET", url: "https://wrong.com" }]]) expect(() => parseVerifierResponse(bytes(envelope({ attempts })), request)).toThrow();
});

it("validates exact redirect edges, resolution, and uncontacted blocked destinations", () => {
  const hop = { fromUrl: request.exactUrl, status: 302, location: "/next", resolvedUrl: "https://public.com/next" };
  const redirected = { ...attempt, httpStatus: 302 };
  const next = { ...attempt, url: "https://public.com/next", startedAtMs: 2, finishedAtMs: 3 };
  expect(parseVerifierResponse(bytes(envelope({ attempts: [redirected, next], redirectChain: [hop], finalUrl: next.url })), request).finalUrl).toBe(next.url);
  for (const changedHop of [{ ...hop, fromUrl: "https://wrong.com" }, { ...hop, resolvedUrl: "https://wrong.com" }]) expect(() => parseVerifierResponse(bytes(envelope({ attempts: [redirected, next], redirectChain: [changedHop], finalUrl: next.url })), request)).toThrow();
  const blocked = { ...hop, location: "http://public.com/next", resolvedUrl: "http://public.com/next" };
  expect(parseVerifierResponse(bytes(envelope({ code: "protocol_downgrade", attempts: [redirected], redirectChain: [blocked], finalUrl: null, httpStatus: 302 })), request).code).toBe("protocol_downgrade");
  expect(() => parseVerifierResponse(bytes(envelope({ code: "protocol_downgrade", attempts: [redirected, { ...next, url: blocked.resolvedUrl }], redirectChain: [blocked], finalUrl: null, httpStatus: 302 })), request)).toThrow();
});

it("replaces service envelope messages with fixed branded messages", () => {
  expect(() => parseVerifierResponse(bytes({ version: 1, requestId: id, status: "failed", error: { code: "verifier_timeout", message: "secret" } }), request)).toThrow(expect.objectContaining({ code: "verifier_timeout", message: "Official-link verifier request timed out." }));
  expect(() => parseVerifierResponse(bytes({}), request)).toThrow(expect.objectContaining({ code: "verifier_protocol_error" }));
});

it("counts stream bytes before decoding and cancels oversize bodies", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(10000)); }, cancel() { cancelled = true; } }));
  await expect(readVerifierBody(response, 16384)).rejects.toMatchObject({ code: "verifier_invalid_response" });
  expect(cancelled).toBe(true);
});

it("round-trips real V2.5 redirect and transport failure forms without changing them", async () => {
  const cases: Array<{ code: VerificationCode; locations?: string[]; destinationFailure?: "dns_failure" | "timeout" | "unsafe_destination"; transportFailure?: "network_error" | "tls_error" | "timeout" | "unsafe_destination"; missing?: boolean; fallback?: boolean }> = [
    { code: "http_result" }, { code: "http_result", fallback: true, locations: ["/head"] },
    { code: "invalid_redirect", missing: true }, { code: "invalid_redirect", locations: [""] },
    { code: "invalid_redirect", locations: ["x".repeat(2049)] }, { code: "unsupported_scheme", locations: ["ftp://public.com/file"] },
    { code: "unsafe_destination", locations: ["https://user:pass@public.com"] },
    { code: "protocol_downgrade", locations: ["http://public.com"] },
    { code: "redirect_loop", locations: [request.exactUrl] },
    { code: "redirect_loop", locations: ["https://public.com./raw#different"] },
    { code: "too_many_redirects", locations: ["/1", "/2", "/3", "/4", "/5", "/6"] },
    ...(["dns_failure", "timeout", "unsafe_destination"] as const).map(code => ({ code, locations: ["/next"], destinationFailure: code })),
    ...(["network_error", "tls_error", "timeout", "unsafe_destination"] as const).map(code => ({ code, locations: ["/next"], transportFailure: code })),
  ];
  for (const test of cases) {
    let step = 0, clock = 100;
    const outcome = await verifyUrl(request.exactUrl, { executeChain: (exactUrl, method, options) => executeRedirectChain(exactUrl, method, {
      now: () => new Date(clock++),
      resolveDestination: async target => step > 0 && test.destinationFailure ? { ok: false, code: test.destinationFailure } : { ok: true, value: { ...target, selectedAddress: { address: "8.8.8.8", family: 4 } } },
      request: async (target, method) => {
        const location = test.locations?.[step++];
        const status = location !== undefined || test.missing ? 302 : test.fallback && method === "HEAD" ? 405 : 200;
        const failure = step > 1 ? test.transportFailure : undefined;
        const attempt = { method, url: target.exactUrl, resolvedAddress: "8.8.8.8", addressFamily: 4 as const, httpStatus: failure ? null : status, startedAt: new Date(clock++), finishedAt: new Date(clock++) };
        return failure ? { kind: "failure", code: failure, attempt } : { kind: "response", status, locations: location === undefined ? [] : [location], attempt };
      },
    }, options) });
    expect(outcome.code).toBe(test.code);
    expect(parseVerifierResponse(encodeVerifierOutcome(id, outcome), request)).toEqual(outcome);
  }
});

it("rejects transport failures fabricated from a completed HTTP request", () => {
  for (const code of ["network_error", "tls_error", "dns_failure", "unsafe_destination", "unsupported_scheme"]) expect(() => parseVerifierResponse(bytes(envelope({ code, finalUrl: null, httpStatus: null })), request)).toThrow(expect.objectContaining({ code: "verifier_invalid_response" }));
});

it("round-trips native GET failures before an attempt while retaining completed HEAD attempts", async () => {
  for (const code of ["dns_failure", "unsafe_destination", "timeout", "network_error"] as const) {
    for (const headStatus of [400, 403, 404, 405, 501]) {
      for (const redirectedHead of [false, true]) {
        let clock = 100;
        const outcome = await verifyUrl(request.exactUrl, {
          executeChain: (exactUrl, method, options) => executeRedirectChain(exactUrl, method, {
            now: () => new Date(clock++),
            resolveDestination: async target => method === "GET" && code !== "network_error"
              ? { ok: false, code }
              : { ok: true, value: { ...target, selectedAddress: { address: "8.8.8.8", family: 4 } } },
            request: async (target, method) => {
              if (method === "GET") throw new Error("request failed before recording an attempt");
              const redirect = redirectedHead && target.exactUrl === request.exactUrl;
              const status = redirect ? 302 : headStatus;
              return {
                kind: "response", status, locations: redirect ? ["/head-only"] : [],
                attempt: { method, url: target.exactUrl, resolvedAddress: "8.8.8.8", addressFamily: 4, httpStatus: status, startedAt: new Date(clock++), finishedAt: new Date(clock++) },
              };
            },
          }, options),
        });
        expect(outcome).toMatchObject({ code, redirectChain: [], finalUrl: null, httpStatus: null });
        expect(outcome.attempts.map(attempt => [attempt.method, attempt.httpStatus])).toEqual(redirectedHead ? [["HEAD", 302], ["HEAD", headStatus]] : [["HEAD", headStatus]]);
        expect(parseVerifierResponse(encodeVerifierOutcome(id, outcome), request)).toEqual(outcome);
      }
    }
  }
});

it("rejects retained HEAD failures with impossible codes or terminal observations", () => {
  const retainedHead = { ...attempt, httpStatus: 405 };
  for (const change of [
    { code: "tls_error" }, { code: "invalid_url" }, { code: "unsupported_scheme" },
    { code: "dns_failure", httpStatus: 405 },
    { code: "dns_failure", finalUrl: request.exactUrl },
    { code: "dns_failure", attempts: [{ ...retainedHead, httpStatus: 200 }] },
    { code: "network_error", attempts: [{ ...retainedHead, method: "GET" }] },
    { code: "unsafe_destination", redirectChain: [{ fromUrl: request.exactUrl, status: 302, location: "/head-only", resolvedUrl: "https://public.com/head-only" }] },
  ]) expect(() => parseVerifierResponse(bytes(envelope({ attempts: [retainedHead], finalUrl: null, httpStatus: null, ...change })), request)).toThrow(expect.objectContaining({ code: "verifier_invalid_response" }));
});

it("rejects contacted URLs outside HTTP policy and oversized retained HEAD chains", () => {
  for (const raw of ["ftp://public.com/file", "https://user:pass@public.com/", "https://public.com:8443/"]) {
    const changed = { ...request, exactUrl: raw };
    expect(() => parseVerifierResponse(bytes(envelope({ attempts: [{ ...attempt, url: raw }], finalUrl: raw })), changed)).toThrow();
  }
  const attempts = Array.from({ length: 7 }, (_, index) => ({ ...attempt, url: index ? `https://public.com/${index}` : request.exactUrl, httpStatus: index === 6 ? 405 : 302, startedAtMs: index, finishedAtMs: index }));
  expect(() => parseVerifierResponse(bytes(envelope({ code: "timeout", attempts, finalUrl: null, httpStatus: null, checkedAtMs: 10 })), request)).toThrow();
});
