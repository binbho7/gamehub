import { access } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { HARNESS_SECRETS, startCronHarness, type CronHarness } from "./test-support/cron-harness";
import { signVerifierRequest } from "../verifiers/official-links/remote/mac";
import { VERIFIER_PATH } from "../verifiers/official-links/remote/types";
import { SCHEDULED_IMAGE_PATH } from "../images/scheduled-codec";

vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
const networkFetch = globalThis.fetch;
let h: CronHarness | undefined;
afterEach(async () => { await h?.dispose(); h = undefined; });

it.each(["unavailable", "bad_mac", "malformed"] as const)("fails closed on verifier %s without leaking provider data or invoking Images", async mode => {
  h = await startCronHarness();
  h.verifierMode = mode;
  const result = await h.run();
  expect(result).toMatchObject({ status: "partial", failed: 1, leaseDisposition: "released" });
  expect(result.games[0].stages[2]).toMatchObject({ name: "links", status: "failed" });
  expect(result.games[0].stages[3]).toMatchObject({ name: "images", status: "not_run" });
  const publicOutput = JSON.stringify({ result, logs: h.logs });
  for (const secret of [...Object.values(HARNESS_SECRETS), "raw-url-secret-canary", "provider-body-secret-canary", "access-token-secret-canary", "ownerToken", "signature", "stack"]) expect(publicOutput).not.toContain(secret);
  expect(h.downloads).toBe(0);
  expect(h.imageResponses).toHaveLength(0);
}, 40_000);

it("uses the authenticated verifier again after a cold process restart", async () => {
  h = await startCronHarness();
  expect(await h.run()).toMatchObject({ status: "completed" });
  await h.restartVerifier();
  await h.binding.prepare("UPDATE game_official_links SET verification_status='unverified',last_checked_at=NULL").run();
  expect(await h.run()).toMatchObject({ status: "completed" });
}, 40_000);

it("authenticates scheduled images before parsing or touching target, R2, or D1", async () => {
  h = await startCronHarness();
  const before = await h.snapshot();
  for (const token of [undefined, HARNESS_SECRETS.legacy, "wrong-token"]) {
    const response = await h.imageRequest(new Request(`http://image${SCHEDULED_IMAGE_PATH}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: "malformed-secret-canary" }));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("canary");
  }
  expect(await h.snapshot()).toEqual(before);
  expect(h.heads).toBe(0);
  expect(h.downloads).toBe(0);
  expect(h.sql).toEqual([]);
}, 40_000);

it("rejects authenticated duplicate, oversized, version, schema, path and method requests before target work", async () => {
  h = await startCronHarness();
  const requestId = crypto.randomUUID();
  const normal = { version: 1, operation: "verify_official_link", requestId, exactUrl: "https://official.example.test/?secret=canary", budgetMs: 1000 };
  const cases = [
    { body: JSON.stringify(normal).replace('"version":1', '"version":1,"version":1'), status: 400 },
    { body: JSON.stringify({ ...normal, version: 2 }), status: 400 },
    { body: JSON.stringify({ ...normal, ownerToken: "secret-canary" }), status: 400 },
    { body: JSON.stringify(normal), path: "/proxy", status: 404 },
    { body: JSON.stringify(normal), method: "PUT", status: 405 },
    { body: "x".repeat(16385), status: 413 },
    { body: JSON.stringify(normal), invalidMac: true, status: 401 },
  ];
  for (const test of cases) {
    const bytes = new TextEncoder().encode(test.body);
    const signed = await signVerifierRequest(HARNESS_SECRETS.verifier, bytes, requestId, Date.now());
    const response = await networkFetch(`${h.verifierOrigin}${test.path ?? VERIFIER_PATH}`, {
      method: test.method ?? "POST", headers: { "content-type": "application/json", "x-gamehub-request-id": signed.requestId, "x-gamehub-timestamp": signed.timestampMs, "x-gamehub-mac": test.invalidMac ? "0".repeat(64) : signed.mac }, body: bytes,
    });
    expect(response.status).toBe(test.status);
    expect(await response.text()).not.toContain("secret-canary");
  }
  expect(h.events).toEqual([]);
  expect(h.verifierTargets).toBe(0);
  expect(h.downloads).toBe(0);
}, 40_000);

it.each(["d1", "verifier", "image"] as const)("cleans every acquired resource exactly once after partial startup at %s", async failAfter => {
  const entries: Array<{ name: string; operation: string; root: string }> = [];
  await expect(startCronHarness({ failAfter, onResource(name, operation, root) { entries.push({ name, operation, root }); } })).rejects.toThrow(`Injected failure after ${failAfter}`);
  const acquired = entries.filter(entry => entry.operation === "acquired").map(entry => entry.name);
  expect(entries.filter(entry => entry.operation === "disposed").map(entry => entry.name)).toEqual([...acquired].reverse());
  await expect(access(entries[0].root)).rejects.toThrow();
}, 40_000);
