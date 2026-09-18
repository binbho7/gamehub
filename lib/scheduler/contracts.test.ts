import { describe, expect, it } from "vitest";
import { parseCronSyncConfig } from "./config";
import { FenceLostError, safeCronError } from "./errors";
import { createCronSignals } from "./signals";
import { parseScheduledMutationAuthority, type UnsettledImageWorkReason } from "./types";

describe("scheduler contracts", () => {
  it("keeps authority loss and image uncertainty monotonic", () => {
    const signals = createCronSignals();
    signals.markUnsettled("image_deadline");
    signals.markAuthorityLoss("lease_lost");
    signals.markAuthorityLoss("fence_lost");
    signals.markAuthorityLoss("lease_lost");
    expect(signals.readUnsettledImageWork()).toEqual(["image_deadline"]);
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
  });

  it("defaults to the approved admission inequalities", () => {
    expect(parseCronSyncConfig({})).toEqual({
      batchSize: 25,
      platformWallBudgetMs: 900000,
      softDeadlineMs: 720000,
      gameAdmissionReserveMs: 780000,
      finishReserveMs: 30000,
      leaseDurationMs: 1500000,
    });
  });

  it("rejects unsafe configuration and authority values", () => {
    expect(() => parseCronSyncConfig({ batchSize: 0 })).toThrow();
    expect(() => parseCronSyncConfig({ batchSize: 26 })).toThrow();
    expect(() => parseCronSyncConfig(null)).toThrow();
    expect(() => parseCronSyncConfig({ unknown: true })).toThrow();
    expect(() => parseCronSyncConfig({ platformWallBudgetMs: 900001 })).toThrow();
    expect(() => parseCronSyncConfig({ softDeadlineMs: 720001 })).toThrow();
    expect(() => parseCronSyncConfig({ softDeadlineMs: 780000 })).toThrow();
    expect(() => parseCronSyncConfig({ gameAdmissionReserveMs: 779999 })).toThrow();
    expect(() => parseCronSyncConfig({ finishReserveMs: 29999 })).toThrow();
    expect(() => parseCronSyncConfig({ leaseDurationMs: 1499999 })).toThrow();
    expect(() => parseScheduledMutationAuthority({ ownerToken: "x", fenceEpoch: 1, leaseExpiresAtMs: 1 })).toThrow();
    expect(() => parseScheduledMutationAuthority({ ownerToken: crypto.randomUUID(), fenceEpoch: 0, leaseExpiresAtMs: 1 })).toThrow();
    expect(() => parseScheduledMutationAuthority({ ownerToken: crypto.randomUUID(), fenceEpoch: Number.MAX_SAFE_INTEGER + 1, leaseExpiresAtMs: 1 })).toThrow();
    expect(() => parseScheduledMutationAuthority({ ownerToken: crypto.randomUUID(), fenceEpoch: 1, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => parseScheduledMutationAuthority({ ownerToken: crypto.randomUUID(), fenceEpoch: 1, leaseExpiresAtMs: 0 })).toThrow();
  });

  it("copies and freezes accepted authority", () => {
    const input = { ownerToken: crypto.randomUUID(), fenceEpoch: 4, leaseExpiresAtMs: 1234 };
    const authority = parseScheduledMutationAuthority(input);
    expect(authority).toEqual(input);
    expect(authority).not.toBe(input);
    expect(Object.isFrozen(authority)).toBe(true);
  });

  it("does not expose mutable latch state", () => {
    const signals = createCronSignals();
    signals.markUnsettled("image_deadline");
    const snapshot = signals.readUnsettledImageWork();
    expect(() => (snapshot as UnsettledImageWorkReason[]).push("image_delivery_unknown")).toThrow();
    expect(signals.readUnsettledImageWork()).toEqual(["image_deadline"]);
  });

  it("exposes only fixed safe errors", () => {
    expect(safeCronError("lease_lost")).toEqual({
      code: "lease_lost",
      message: "The Cron sync lease was lost before an authoritative operation completed.",
    });
    expect(Object.keys(safeCronError("lease_lost"))).toEqual(["code", "message"]);
    expect(new FenceLostError()).toMatchObject({ code: "fence_lost" });
  });
});
