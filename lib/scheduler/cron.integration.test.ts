import { afterEach, expect, it, vi } from "vitest";
import { startCronHarness, type CronHarness } from "./test-support/cron-harness";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";

// Only the platform base class is unavailable in Node. All application composition is real.
vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
let h: CronHarness | undefined;
afterEach(async () => { await h?.dispose(); h = undefined; });

it("runs all four real stages, publishes after R2 completion, and repeats with HEAD only", async () => {
  h = await startCronHarness();
  const first = await h.run();
  expect(first, JSON.stringify(first)).toMatchObject({ status: "completed", succeeded: 1, leaseDisposition: "released" });
  expect(first.games[0].stages.map(stage => stage.name)).toEqual(["steam", "igdb", "links", "images"]);
  expect(h.events.filter(event => ["steam", "igdb", "links", "images"].includes(event.kind)).map(event => event.kind)).toEqual(["steam", "igdb", "links", "images"]);
  const put = h.events.findIndex(event => event.kind === "r2.put.completed");
  expect(put).toBeGreaterThanOrEqual(0);
  expect(h.events.findIndex(event => event.kind === "d1.bind.attempted")).toBeGreaterThan(put);
  expect(h.imageResponses[0].images.map(image => image.outcome)).toEqual(["ingested"]);
  expect(h.imageResponses[0].images[0]).toMatchObject({ dimensions: { width: 48, height: 32 }, byteCount: 29, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const before = await h.counts();
  const downloads = h.downloads;
  const puts = h.events.filter(event => event.kind === "r2.put.completed").length;
  const heads = h.heads;
  expect(await h.run()).toMatchObject({ status: "completed", succeeded: 1 });
  expect(await h.counts()).toEqual(before);
  expect(h.imageResponses[1].images.map(image => image.outcome)).toEqual(["already_ingested"]);
  expect(h.downloads).toBe(downloads);
  expect(h.heads).toBeGreaterThan(heads);
  expect(h.events.filter(event => event.kind === "r2.put.completed")).toHaveLength(puts);
}, 40_000);

it.each(["r2_put", "d1_bind", "d1_create"] as const)("retains the lease after a native deadline at %s and fences orphaned work after takeover", async point => {
  h = await startCronHarness({ manualImageClock: true });
  await h.seed(20);
  if (point === "d1_create") await h.binding.prepare("DELETE FROM game_images WHERE game_id=10").run();
  const pause = h.pause(point);
  const running = h.run();
  await pause.reached;
  h.expireImageDeadline();
  const returned = await running;
  expect(returned).toMatchObject({ status: "partial", attempted: 1, failed: 1, notStarted: 1, stopReason: "unsettled_remote_work", leaseDisposition: "retained_until_expiry" });
  expect(h.imageResponses).toHaveLength(1);
  expect(h.imageResponses[0].images[0]).toMatchObject({ outcome: "deadline" });
  expect(await h.binding.prepare("SELECT last_status FROM game_cron_sync_state WHERE game_id=10").first()).toMatchObject({ last_status: "failed" });
  const leases = createLeaseRepository(h.binding);
  expect((await leases.acquire(crypto.randomUUID(), 1_500_000)).status).toBe("held");
  await h.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
  expect((await leases.acquire(crypto.randomUUID(), 1_500_000)).status).toBe("acquired");
  const before = await h.snapshot();
  // The returned caller and its signals cannot cancel the already-dispatched operation.
  pause.resume();
  if (point === "r2_put") await vi.waitFor(() => expect(h!.events.some(event => event.kind === "r2.put.completed")).toBe(true));
  else await vi.waitFor(() => expect(h!.imageAuthorityLosses()).toContain("fence_lost"));
  expect(await h.snapshot()).toEqual(before);
  expect(h.imageResponses).toHaveLength(1);
}, 40_000);

it.each(["steam_response", "igdb_response", "verifier_response", "r2_put", "d1_bind", "d1_create"] as const)("rejects stale publication after paused %s and a higher epoch", async point => {
  h = await startCronHarness();
  if (point === "d1_create") await h.binding.prepare("DELETE FROM game_images").run();
  const pause = h.pause(point);
  const running = h.run();
  await pause.reached;
  const lease = createLeaseRepository(h.binding);
  expect((await lease.acquire(crypto.randomUUID(), 1_500_000)).status).toBe("held");
  await h.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
  const winner = await lease.acquire(crypto.randomUUID(), 1_500_000);
  expect(winner.status).toBe("acquired");
  const before = await h.snapshot();
  pause.resume();
  expect(await running).toMatchObject({ status: "failed", stopReason: "authority_lost", leaseDisposition: "no_longer_owned", attempted: 1 });
  expect(await h.snapshot()).toEqual(before);
  expect(await h.binding.prepare("SELECT last_status FROM game_cron_sync_state").first()).toMatchObject({ last_status: "started" });
}, 40_000);

it("isolates an ordinary failed game and admits the next healthy game", async () => {
  h = await startCronHarness();
  await h.seed(20);
  h.rejectSteam.add("10");
  expect(await h.run()).toMatchObject({ status: "partial", attempted: 2, succeeded: 1, failed: 1, leaseDisposition: "released" });
  expect((await h.binding.prepare("SELECT last_status FROM game_cron_sync_state ORDER BY game_id").all()).results).toEqual([{ last_status: "failed" }, { last_status: "succeeded" }]);
}, 40_000);

it("completes the admitted game when the soft cutoff arrives and leaves the next untouched", async () => {
  h = await startCronHarness();
  await h.seed(20);
  const pause = h.pause("steam_response");
  const running = h.run();
  await pause.reached;
  h.elapsedMs = 720_000;
  pause.resume();
  expect(await running).toMatchObject({ status: "partial", attempted: 1, succeeded: 1, notStarted: 1, stopReason: "soft_deadline", leaseDisposition: "released" });
}, 40_000);

it("allows a newer invocation to finish while a crashed caller's Steam response remains pending", async () => {
  h = await startCronHarness();
  const pause = h.pause("steam_response");
  const old = h.run();
  await pause.reached;
  expect(await h.run()).toMatchObject({ status: "skipped", attempted: 0, stopReason: "active_lease" });
  await h.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
  expect(await h.run()).toMatchObject({ status: "completed", succeeded: 1 });
  const committed = await h.snapshot();
  pause.resume();
  expect(await old).toMatchObject({ status: "failed", stopReason: "authority_lost" });
  expect(await h.snapshot()).toEqual(committed);
}, 40_000);

it("rejects expired-owner writes even without a replacement owner", async () => {
  h = await startCronHarness();
  const pause = h.pause("igdb_response");
  const running = h.run();
  await pause.reached;
  await h.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
  const before = await h.snapshot();
  pause.resume();
  expect(await running).toMatchObject({ status: "failed", stopReason: "authority_lost", leaseDisposition: "no_longer_owned" });
  expect(await h.snapshot()).toEqual(before);
}, 40_000);

it.each(["finish", "release"] as const)("keeps successful business writes and safe diagnostics after %s failure", async phase => {
  h = await startCronHarness();
  h.failPhase = phase;
  const result = await h.run();
  expect(result).toMatchObject({ status: "failed", succeeded: 1, primaryError: { code: phase === "finish" ? "state_write_failed" : "lease_release_failed" }, leaseDisposition: phase === "finish" ? "released" : "retained_until_expiry" });
  expect(await h.binding.prepare("SELECT storage_key FROM game_images").first()).toMatchObject({ storage_key: expect.stringContaining("images/") });
  expect(JSON.stringify(result)).not.toContain("secret-canary");
}, 40_000);

it.each([false, true])("scans the complete native result when ordinary image failure precedes/follows a deadline, reverse=%s", async reverse => {
  h = await startCronHarness({ manualImageClock: true });
  await h.seed(20);
  const bad = "https://cdn.akamai.steamstatic.com/steam/apps/10/bad.jpg";
  h.badImages.add(bad);
  await h.binding.prepare("UPDATE games SET cover_url=NULL WHERE id=10").run();
  await h.binding.prepare("UPDATE game_images SET sort_order=? WHERE game_id=10").bind(reverse ? 0 : 1).run();
  await h.binding.prepare("INSERT INTO game_images(game_id,type,source_url,source_provider,sort_order) VALUES(10,'screenshot',?,'steam',?)").bind(bad, reverse ? 1 : 0).run();
  const pause = h.pause("d1_bind");
  const running = h.run();
  await pause.reached;
  h.expireImageDeadline();
  expect(await running).toMatchObject({ status: "partial", attempted: 1, notStarted: 1, stopReason: "unsettled_remote_work", leaseDisposition: "retained_until_expiry" });
  expect(h.imageResponses[0].images.map(image => image.outcome)).toEqual(reverse ? ["deadline", "mime_mismatch"] : ["mime_mismatch", "deadline"]);
  const item = h.imageResponses[0].images.find(image => image.outcome === "deadline")!;
  expect(item).toMatchObject({ error: { code: "image_deadline" }, attempts: [{ errorCode: "image_deadline" }] });
  await h.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
  const before = await h.snapshot();
  pause.resume();
  await vi.waitFor(() => expect(h!.imageAuthorityLosses()).toContain("fence_lost"));
  expect(await h.snapshot()).toEqual(before);
  expect(h.imageResponses).toHaveLength(1);
}, 40_000);
