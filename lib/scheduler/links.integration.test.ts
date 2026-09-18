import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLinkVerificationStore } from "../db/repositories/link-verification";
import { buildLinkVerificationQueries } from "../db/repositories/link-verification-queries";
import { executeFencedBatch, fencePredicate } from "../db/repositories/scheduled/fence";
import { createScheduledLinkStore } from "../db/repositories/scheduled/links";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import { createLinkVerificationService } from "../verifiers/official-links/service";
import { createRemoteVerifierTransport } from "../verifiers/official-links/remote/client";
import { parseVerifierRequest } from "../verifiers/official-links/remote/codec";
import { signVerifierResponse } from "../verifiers/official-links/remote/mac";
import type { TerminalOutcome } from "../verifiers/official-links/types";
import { createLinkStage } from "../sync/link-stage";
import { createCronSignals } from "./signals";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";

const secret = "a".repeat(64);
const checkedAt = new Date(10000);

function terminal(url: string, code: TerminalOutcome["code"] = "http_result", httpStatus = 200): TerminalOutcome {
  return {
    code, checkedAt, redirectChain: [], finalUrl: code === "http_result" ? url : null,
    httpStatus: code === "http_result" ? httpStatus : null,
    attempts: code === "unsafe_destination" ? [] : [{ method: "HEAD", url, resolvedAddress: "93.184.216.34", addressFamily: 4,
      httpStatus: code === "http_result" ? httpStatus : null, startedAt: checkedAt, finishedAt: checkedAt }],
  };
}

async function reply(request: Request, code: TerminalOutcome["code"] = "http_result", httpStatus = 200) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const parsed = parseVerifierRequest(bytes);
  const outcome = terminal(parsed.exactUrl, code, httpStatus);
  const body = new TextEncoder().encode(JSON.stringify({
    version: 1, requestId: parsed.requestId, status: "completed", outcome: {
      code: outcome.code, redirectChain: [], finalUrl: outcome.finalUrl, httpStatus: outcome.httpStatus,
      checkedAtMs: checkedAt.getTime(), attempts: outcome.attempts.map(({ startedAt, finishedAt, ...attempt }) => ({
        ...attempt, startedAtMs: startedAt.getTime(), finishedAtMs: finishedAt.getTime(),
      })),
    },
  }));
  return new Response(body, { headers: { "Content-Type": "application/json",
    "X-GameHub-Mac": await signVerifierResponse(secret, bytes, parsed.requestId, 200, body) } });
}

function remote(fetch: (request: Request) => Promise<Response>) {
  return createRemoteVerifierTransport({ binding: { start: async () => {}, fetch }, secret,
    nowMs: () => Date.now(), newRequestId: () => crypto.randomUUID() });
}

describe("scheduled official-link publication", () => {
  let f: SchedulerD1Fixture;
  beforeAll(async () => { f = await createSchedulerD1Fixture(); }, 30_000);
  afterAll(async () => { await f?.dispose(); });
  beforeEach(async () => {
    await f.binding.prepare("DELETE FROM games").run();
    await f.binding.prepare("DELETE FROM cron_sync_lease").run();
    await f.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
    await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(9,'g9','Game'),(10,'g10','Other')").run();
    await f.binding.prepare(`INSERT INTO game_official_links
      (id,game_id,provider,platform,link_type,url,region,is_official,created_at,updated_at)
      VALUES(1,9,'publisher','windows','official_website','https://example.com/1','GB',1,1000,2000)`).run();
  });

  async function scheduled() {
    const acquired = await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000);
    if (acquired.status !== "acquired") throw new Error("fixture lease unavailable");
    const signals = createCronSignals();
    const store = createScheduledLinkStore({ binding: f.binding, db: f.db, authority: acquired.lease, signals });
    return { store, signals, authority: acquired.lease };
  }

  async function expire(replace = true) {
    await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
    if (replace) await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), 1_500_000);
  }

  async function stored() {
    return (await f.binding.prepare("SELECT * FROM game_official_links ORDER BY id").all()).results;
  }

  async function secondLink() {
    await f.binding.prepare(`INSERT INTO game_official_links(id,game_id,provider,link_type,url,created_at,updated_at)
      VALUES(2,9,'publisher','official_website','https://example.com/2',1000,2000)`).run();
  }

  it("negative control: the unfenced store publishes a stale result", async () => {
    await scheduled();
    const store = createLinkVerificationStore(f.db);
    const service = createLinkVerificationService({ store, verifyUrl: async url => terminal(url) });
    const planned = await service.verifyGame(9);
    await expire();
    expect(await store.writePlan(planned.plan)).toEqual({ affectedRows: 1, appliedLinkIds: [1], conflicts: [] });
    expect((await stored())[0]).toMatchObject({ verification_status: "verified", last_checked_at: 10000 });
  });

  it("rejects a valid late Container response after B acquires and preserves exact metadata", async () => {
    const { store, signals } = await scheduled();
    let reached!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const held = new Promise<void>(resolve => { resume = resolve; });
    const transport = remote(async request => { reached(); await held; return reply(request); });
    const service = createLinkVerificationService({ store, verifyUrl: transport.verify.bind(transport) });
    const pending = service.verifyGame(9, { dryRun: false });
    await paused;
    await expire();
    const before = await f.dump();
    resume();
    await expect(pending).rejects.toMatchObject({ code: "write_failed", message: "Unable to write link verification data" });
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
    expect(await f.dump()).toEqual(before);
  });

  it.each([false, true])("guards every standalone update after expiry (replacement: %s)", async replace => {
    await secondLink();
    const { store, authority } = await scheduled();
    const service = createLinkVerificationService({ store, verifyUrl: async url => terminal(url) });
    const { plan } = await service.verifyGame(9);
    const updates = buildLinkVerificationQueries(f.db, plan, fencePredicate(authority));
    await expire(replace);
    const before = await f.dump();
    const results = await f.binding.batch(updates.map(update => f.binding.prepare(update.sql).bind(...update.params)));
    expect(results.map(result => result.meta.changes)).toEqual([0, 0]);
    expect(await f.dump()).toEqual(before);
  });

  it("rolls back every link update if authority expires before the final assertion", async () => {
    await secondLink();
    const { store, authority } = await scheduled();
    const { plan } = await createLinkVerificationService({ store, verifyUrl: async url => terminal(url) }).verifyGame(9);
    const before = await f.dump();
    await expect(executeFencedBatch(f.binding, authority, [
      ...buildLinkVerificationQueries(f.db, plan, fencePredicate(authority)),
      { sql: "UPDATE cron_sync_lease SET lease_expires_at=1 WHERE name='game-sync'", params: [], minChanges: 1, maxChanges: 1 },
    ])).rejects.toMatchObject({ code: "fence_lost" });
    expect(await f.dump()).toEqual(before);
  });

  it("returns applied IDs only for current rows and excludes a matching manually owned snapshot", async () => {
    await secondLink();
    const { store, signals } = await scheduled();
    const { plan } = await createLinkVerificationService({ store, verifyUrl: async url => terminal(url) }).verifyGame(9);
    await f.binding.prepare("UPDATE game_official_links SET verification_method='manual' WHERE id=2").run();
    const manual = plan.items[1];
    if (manual.action !== "update") throw new Error("expected writable fixture");
    manual.snapshot.verificationMethod = "manual";
    expect(await store.writePlan(plan)).toEqual({ affectedRows: 1, appliedLinkIds: [1],
      conflicts: [{ linkId: 2, code: "write_conflict" }] });
    expect((await stored())[1]).toMatchObject({ verification_method: "manual", verification_status: "unverified", last_checked_at: null });
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it("rolls back siblings on a SQL failure without falsely latching authority loss", async () => {
    await secondLink();
    const { store, signals } = await scheduled();
    const { plan } = await createLinkVerificationService({ store, verifyUrl: async url => terminal(url) }).verifyGame(9);
    const invalid = plan.items[1];
    if (invalid.action !== "update") throw new Error("expected writable fixture");
    invalid.changes.httpStatus = 600;
    const before = await f.dump();
    await expect(store.writePlan(plan)).rejects.toMatchObject({ code: "write_failed", message: "Unable to write link verification data" });
    expect(await f.dump()).toEqual(before);
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it("rejects invalid D1 mutation counts as write failures without claiming authority loss", async () => {
    const { store, authority, signals } = await scheduled();
    const { plan } = await createLinkVerificationService({ store, verifyUrl: async url => terminal(url) }).verifyGame(9);
    // Only corrupt the external D1 response; SQL execution and both assertions remain real.
    const binding = new Proxy(f.binding, {
      get(target, key) {
        if (key === "batch") return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          results[1].meta.changes = 2;
          return results;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const invalidStore = createScheduledLinkStore({ binding, db: f.db, authority, signals });
    await expect(invalidStore.writePlan(plan)).rejects.toMatchObject({ code: "write_failed", message: "Unable to write link verification data" });
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it.each(["empty", "manual", "unchanged"])("validates authority for a %s plan", async kind => {
    const { store, signals } = await scheduled();
    if (kind === "empty") await f.binding.prepare("DELETE FROM game_official_links").run();
    if (kind === "manual") await f.binding.prepare("UPDATE game_official_links SET verification_method='manual'").run();
    const service = createLinkVerificationService({ store, verifyUrl: async url => terminal(url), now: () => checkedAt });
    if (kind === "unchanged") await service.verifyGame(9, { dryRun: false });
    expect(await service.verifyGame(9, { dryRun: false })).toMatchObject({ status: "no_changes", affectedRows: 0 });
    await expire(false);
    const before = await f.dump();
    await expect(service.verifyGame(9, { dryRun: false })).rejects.toMatchObject({ code: "write_failed" });
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
    expect(await f.dump()).toEqual(before);
  });

  it.each([
    ["id", "id=11"], ["game", "game_id=10"], ["URL", "url='https://example.com/edited'"],
    ["updated time", "updated_at=2001"], ["status", "verification_status='pending'"],
    ["method", "verification_method='provider_api'"], ["HTTP status", "http_status=201"],
    ["redirect", "redirect_url='https://example.com/redirect'"], ["verified time", "verified_at=3000"],
    ["checked time", "last_checked_at=4000"], ["manual owner", "verification_method='manual'"],
  ])("preserves a %s snapshot race during verification", async (_name, edit) => {
    const { store, signals } = await scheduled();
    let raced: unknown[] = [];
    const service = createLinkVerificationService({ store, verifyUrl: async url => {
      await f.binding.prepare(`UPDATE game_official_links SET ${edit} WHERE id=1`).run();
      raced = await stored();
      return terminal(url);
    } });
    expect(await service.verifyGame(9, { dryRun: false })).toMatchObject({ status: "no_changes", affectedRows: 0,
      conflicts: [{ linkId: 1, code: "write_conflict" }] });
    expect(await stored()).toEqual(raced);
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it("commits a current sibling and returns partial application for a manual edit", async () => {
    await secondLink();
    const { store, signals } = await scheduled();
    const service = createLinkVerificationService({ store, verifyUrl: async url => {
      await f.binding.prepare("UPDATE game_official_links SET verification_method='manual' WHERE id=2").run();
      return terminal(url);
    }, now: () => new Date(11000) });
    expect(await service.verifyGame(9, { dryRun: false })).toMatchObject({ status: "partially_applied", affectedRows: 1,
      conflicts: [{ linkId: 2, code: "write_conflict" }] });
    expect((await stored())[0]).toMatchObject({ id: 1, game_id: 9, provider: "publisher", platform: "windows",
      link_type: "official_website", url: "https://example.com/1", region: "GB", is_official: 1,
      created_at: 1000, updated_at: 11000, verification_status: "verified", verification_method: "http",
      http_status: 200, redirect_url: null, verified_at: 10000, last_checked_at: 10000 });
    expect((await stored())[1]).toMatchObject({ verification_method: "manual", verification_status: "unverified",
      updated_at: 2000, last_checked_at: null });
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it.each(["unavailable", "auth", "unknown"])("never publishes an earlier observed link when a later RPC fails: %s", async failure => {
    await secondLink();
    const { store, signals } = await scheduled();
    let calls = 0;
    const transport = remote(async request => {
      if (++calls === 1) return reply(request, "unsafe_destination");
      if (failure === "unknown") throw new Error("private service detail");
      return new Response(null, { status: failure === "auth" ? 401 : 503 });
    });
    const service = createLinkVerificationService({ store, verifyUrl: transport.verify.bind(transport) });
    const before = await f.dump();
    await expect(createLinkStage(service).execute(9, { dryRun: false })).rejects.toMatchObject({
      stage: "links", code: failure === "auth" ? "verifier_auth_error" : "verifier_service_unavailable",
    });
    expect(await f.dump()).toEqual(before);
    expect(signals.readAuthorityLoss()).toBeNull();
  });

  it.each([
    ["http_result", 404, "broken"], ["unsafe_destination", 200, "unsafe"], ["network_error", 200, "unknown"],
  ] as const)("preserves native target outcome %s through remote classification and stage", async (code, status, classification) => {
    const { store, signals } = await scheduled();
    const transport = remote(request => reply(request, code, status));
    const service = createLinkVerificationService({ store, verifyUrl: transport.verify.bind(transport) });
    const pending = createLinkStage(service).execute(9, { dryRun: false });
    if (code === "http_result") await expect(pending).resolves.toMatchObject({ summary: "Links applied; checked=1; broken=1." });
    else await expect(pending).rejects.toMatchObject({ stage: "links", code });
    expect((await stored())[0]).toMatchObject({ verification_status: classification, verification_method: "http",
      http_status: code === "http_result" ? 404 : null, last_checked_at: 10000 });
    expect(signals.readAuthorityLoss()).toBeNull();
  });
});
