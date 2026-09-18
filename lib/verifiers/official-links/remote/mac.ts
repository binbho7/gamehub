import { UUID_PATTERN, type VerifierMacHeaders } from "./types";

const encoder = new TextEncoder();
const HEX = /^[0-9a-f]{64}$/;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
async function hash(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}
async function sign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}
function equalMac(actual: string, expected: string): boolean {
  if (!HEX.test(actual)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i += 2) difference |= parseInt(actual.slice(i, i + 2), 16) ^ parseInt(expected.slice(i, i + 2), 16);
  return difference === 0;
}
export async function signVerifierRequest(secret: string, body: Uint8Array, requestId: string, timestampMs: number): Promise<VerifierMacHeaders> {
  const timestamp = String(timestampMs);
  return { requestId, timestampMs: timestamp, mac: await sign(secret, `request-v1\n${requestId}\n${timestamp}\n${await hash(body)}`) };
}
export async function verifyVerifierRequest(secret: string, body: Uint8Array, headers: VerifierMacHeaders, nowMs: number): Promise<boolean> {
  if (!UUID_PATTERN.test(headers.requestId) || !/^(0|[1-9][0-9]{0,15})$/.test(headers.timestampMs) || !HEX.test(headers.mac)) return false;
  const timestamp = Number(headers.timestampMs);
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(nowMs) || Math.abs(nowMs - timestamp) > 30000) return false;
  return equalMac(headers.mac, (await signVerifierRequest(secret, body, headers.requestId, timestamp)).mac);
}
export async function signVerifierResponse(secret: string, requestBody: Uint8Array, requestId: string, status: number, responseBody: Uint8Array): Promise<string> {
  return sign(secret, `response-v1\n${requestId}\n${await hash(requestBody)}\n${status}\n${await hash(responseBody)}`);
}
export async function verifyVerifierResponse(secret: string, requestBody: Uint8Array, requestId: string, status: number, responseBody: Uint8Array, mac: string): Promise<boolean> {
  if (!UUID_PATTERN.test(requestId) || !HEX.test(mac)) return false;
  return equalMac(mac, await signVerifierResponse(secret, requestBody, requestId, status, responseBody));
}
