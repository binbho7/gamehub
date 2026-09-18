import { createHash, createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { signVerifierRequest, signVerifierResponse, verifyVerifierRequest, verifyVerifierResponse } from "./mac";
const key = "a".repeat(64), id = "11111111-1111-4111-8111-111111111111";
const body = new TextEncoder().encode('{"version":1}');
it("matches an independent HMAC vector and enforces timestamp and header syntax", async () => {
  const headers = await signVerifierRequest(key, body, id, 100000);
  const hash = createHash("sha256").update(body).digest("hex");
  expect(headers.mac).toBe(createHmac("sha256", key).update(`request-v1\n${id}\n100000\n${hash}`).digest("hex"));
  expect(await verifyVerifierRequest(key, body, headers, 130000)).toBe(true);
  expect(await verifyVerifierRequest(key, body, headers, 130001)).toBe(false);
  for (const change of [{ timestampMs: "0100000" }, { mac: headers.mac.toUpperCase() }, { requestId: "bad" }, { timestampMs: "NaN" }, { mac: "0".repeat(64) }]) expect(await verifyVerifierRequest(key, body, { ...headers, ...change }, 100000)).toBe(false);
});
it("binds responses to exact request bytes, correlation id, response bytes and HTTP status", async () => {
  const response = new TextEncoder().encode('{"status":"completed"}');
  const mac = await signVerifierResponse(key, body, id, 200, response);
  expect(await verifyVerifierResponse(key, body, id, 200, response, mac)).toBe(true);
  expect(await verifyVerifierResponse(key, new TextEncoder().encode('{"version":2}'), id, 200, response, mac)).toBe(false);
  expect(await verifyVerifierResponse(key, body, id, 503, response, mac)).toBe(false);
  expect(await verifyVerifierResponse(key, body, id, 200, body, mac)).toBe(false);
  expect(await verifyVerifierResponse(key, body, "22222222-2222-4222-8222-222222222222", 200, response, mac)).toBe(false);
});
