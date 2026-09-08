import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LinkVerificationStore,
  LinkVerificationWriteResult,
} from "../../db/repositories/link-verification";
import { LinkVerificationError } from "./errors";
import {
  createLinkVerificationService,
  type VerifyBoundUrl,
} from "./service";
import type {
  LinkVerificationSnapshot,
  TerminalOutcome,
  VerificationCode,
} from "./types";

const GAME_ID = 7;
const STARTED_AT = new Date("2026-09-05T09:59:59.000Z");
const CHECKED_AT = new Date("2026-09-05T10:00:00.000Z");
const PLAN_TIME = new Date("2026-09-05T10:00:01.000Z");

function snapshot(
  id: number,
  overrides: Partial<LinkVerificationSnapshot> = {},
): LinkVerificationSnapshot {
  return {
    id,
    gameId: GAME_ID,
    url: `https://link-${id}.example.com/path?token=exact-${id}#fragment`,
    updatedAt: new Date("2026-09-04T10:00:00.000Z"),
    verificationStatus: "unverified",
    verificationMethod: null,
    httpStatus: null,
    redirectUrl: null,
    verifiedAt: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

function outcome(
  code: VerificationCode = "http_result",
  httpStatus: number | null = 200,
  checkedAt = CHECKED_AT,
): TerminalOutcome {
  return {
    code,
    attempts: code === "http_result"
      ? [{
          method: "HEAD",
          url: "https://internal.example.com/exact",
          resolvedAddress: "8.8.8.8",
          addressFamily: 4,
          httpStatus,
          startedAt: STARTED_AT,
          finishedAt: checkedAt,
        }]
      : [],
    redirectChain: [],
    finalUrl: code === "http_result" ? "https://internal.example.com/exact" : null,
    httpStatus,
    checkedAt,
  };
}

function writeResult(
  affectedRows = 0,
  conflicts: LinkVerificationWriteResult["conflicts"] = [],
): LinkVerificationWriteResult {
  return {
    affectedRows,
    appliedLinkIds: Array.from({ length: affectedRows }, (_, index) => index + 1),
    conflicts,
  };
}

function harness(input: {
  links?: LinkVerificationSnapshot[];
  gameExists?: boolean;
  verifyUrl?: VerifyBoundUrl;
  write?: LinkVerificationWriteResult;
}) {
  const links = input.links ?? [snapshot(1)];
  const readGameLinks = vi.fn<LinkVerificationStore["readGameLinks"]>(async () => ({
    gameExists: input.gameExists ?? true,
    links,
  }));
  const writePlan = vi.fn<LinkVerificationStore["writePlan"]>(
    async () => input.write ?? writeResult(),
  );
  const store: LinkVerificationStore = { readGameLinks, writePlan };
  const verifyUrl = vi.fn<VerifyBoundUrl>(
    input.verifyUrl ?? (async () => outcome()),
  );
  const service = createLinkVerificationService({
    store,
    verifyUrl,
    now: () => PLAN_TIME,
  });

  return { links, readGameLinks, writePlan, store, verifyUrl, service };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createLinkVerificationService pre-network boundaries", () => {
  it("rejects a missing canonical game before verification or writing", async () => {
    const { service, verifyUrl, writePlan } = harness({ gameExists: false, links: [] });

    await expect(service.verifyGame(GAME_ID)).rejects.toMatchObject({
      code: "game_not_found",
      message: "Canonical GameHub game was not found",
    });
    expect(verifyUrl).not.toHaveBeenCalled();
    expect(writePlan).not.toHaveBeenCalled();
  });

  it("rejects 21 links before the verifier can perform DNS or HTTP work", async () => {
    const links = Array.from({ length: 21 }, (_, index) => snapshot(index + 1));
    const { service, verifyUrl, writePlan } = harness({ links });

    await expect(service.verifyGame(GAME_ID)).rejects.toMatchObject({
      code: "link_limit_exceeded",
      message: "Canonical game has too many official links to verify",
    });
    expect(verifyUrl).not.toHaveBeenCalled();
    expect(writePlan).not.toHaveBeenCalled();
  });

  it("allows exactly 20 links through the verification pipeline", async () => {
    const links = Array.from({ length: 20 }, (_, index) => snapshot(index + 1));
    const { service, verifyUrl } = harness({ links });

    const result = await service.verifyGame(GAME_ID);

    expect(verifyUrl).toHaveBeenCalledTimes(20);
    expect(result.plan.linksRead).toBe(20);
  });

  it("propagates operation-level database failures without starting network work", async () => {
    const error = new LinkVerificationError(
      "database_unavailable",
      "Unable to read link verification data",
    );
    const { service, readGameLinks, verifyUrl, writePlan } = harness({});
    readGameLinks.mockRejectedValueOnce(error);

    await expect(service.verifyGame(GAME_ID)).rejects.toBe(error);
    expect(verifyUrl).not.toHaveBeenCalled();
    expect(writePlan).not.toHaveBeenCalled();
  });
});

describe("createLinkVerificationService sequencing and deadlines", () => {
  it("verifies the stable snapshot order at maximum concurrency one", async () => {
    const links = [snapshot(10), snapshot(20), snapshot(30)];
    const started: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const verifyUrl: VerifyBoundUrl = async (url) => {
      started.push(url);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return outcome();
    };
    const harnessed = harness({ links, verifyUrl });

    await harnessed.service.verifyGame(GAME_ID);

    expect(started).toEqual(links.map((link) => link.url));
    expect(maximumActive).toBe(1);
    expect(harnessed.verifyUrl.mock.calls.map(([, options]) => ({
      linkDeadlineMs: options?.linkDeadlineMs,
      signal: options?.signal,
    }))).toEqual(links.map(() => ({
      linkDeadlineMs: 20_000,
      signal: expect.any(AbortSignal),
    })));
    const signals = harnessed.verifyUrl.mock.calls.map(([, options]) => options?.signal);
    expect(new Set(signals).size).toBe(1);
  });

  it("shares one exact five-minute game deadline across every link", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T10:00:00.000Z"));
    const observedSignals: AbortSignal[] = [];
    const verifyUrl: VerifyBoundUrl = (_url, options) => {
      const signal = options?.signal;
      if (signal === undefined) throw new Error("Expected the game deadline signal");
      observedSignals.push(signal);
      return new Promise((resolve) => {
        const finish = () => resolve(outcome("timeout", null, new Date()));
        if (signal.aborted) finish();
        else signal.addEventListener("abort", finish, { once: true });
      });
    };
    const { service } = harness({ links: [snapshot(1), snapshot(2)], verifyUrl });
    const pending = service.verifyGame(GAME_ID);
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(settled).toBe(false);
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(observedSignals).toHaveLength(2);
    expect(new Set(observedSignals).size).toBe(1);
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(result.plan.verificationResults).toEqual([
      expect.objectContaining({
        linkId: 1,
        classification: "temporarily_unavailable",
        code: "timeout",
        checkedAt: new Date("2026-09-05T10:05:00.000Z"),
      }),
      expect.objectContaining({
        linkId: 2,
        classification: "temporarily_unavailable",
        code: "timeout",
        checkedAt: new Date("2026-09-05T10:05:00.000Z"),
      }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the global deadline after a normal operation", async () => {
    vi.useFakeTimers();
    const { service } = harness({});

    await service.verifyGame(GAME_ID);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createLinkVerificationService dry-run and write results", () => {
  it("defaults to dry-run while performing real verification, classification, and planning", async () => {
    const links = [
      snapshot(1),
      snapshot(2, {
        verificationMethod: "manual",
        verificationStatus: "verified",
        httpStatus: 201,
      }),
    ];
    const terminalOutcomes = [
      outcome("unsafe_destination", null),
      outcome("invalid_redirect", 302),
    ];
    let index = 0;
    const { service, verifyUrl, writePlan } = harness({
      links,
      verifyUrl: async () => terminalOutcomes[index++] as TerminalOutcome,
    });

    const result = await service.verifyGame(GAME_ID);

    expect(verifyUrl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      gameId: GAME_ID,
      dryRun: true,
      status: "planned",
      affectedRows: 0,
      conflicts: [],
      plan: {
        dryRun: true,
        linksRead: 2,
        verificationResults: [
          { linkId: 1, classification: "unsafe", code: "unsafe_destination" },
          { linkId: 2, classification: "broken", code: "invalid_redirect" },
        ],
        items: [
          { action: "update", snapshot: links[0] },
          {
            action: "skip",
            linkId: 2,
            originalUrl: links[1]?.url,
            reason: "manual_verification_preserved",
          },
        ],
      },
    });
    expect(writePlan).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "all approved updates applied",
      write: writeResult(2),
      expectedStatus: "applied",
    },
    {
      label: "some approved updates applied and some conflicted",
      write: writeResult(1, [{ linkId: 2, code: "write_conflict" }]),
      expectedStatus: "partially_applied",
    },
    {
      label: "all approved updates conflicted",
      write: writeResult(0, [{ linkId: 1, code: "write_conflict" }]),
      expectedStatus: "no_changes",
    },
    {
      label: "the plan contained no effective changes",
      write: writeResult(),
      expectedStatus: "no_changes",
    },
  ] as const)("maps write counts when $label", async ({ write, expectedStatus }) => {
    const links = write.affectedRows === 2 ? [snapshot(1), snapshot(2)] : [snapshot(1)];
    const { service, writePlan } = harness({ links, write });

    const result = await service.verifyGame(GAME_ID, { dryRun: false });

    expect(writePlan).toHaveBeenCalledOnce();
    expect(writePlan).toHaveBeenCalledWith(result.plan);
    expect(result).toMatchObject({
      dryRun: false,
      status: expectedStatus,
      affectedRows: write.affectedRows,
      conflicts: write.conflicts,
    });
  });

  it("continues after unsafe, broken, and unknown link outcomes", async () => {
    const links = [snapshot(1), snapshot(2), snapshot(3), snapshot(4)];
    const outcomes = [
      outcome("unsafe_destination", null),
      outcome("invalid_redirect", 302),
      outcome("network_error", null),
      outcome("http_result", 204),
    ];
    let index = 0;
    const { service, verifyUrl } = harness({
      links,
      verifyUrl: async () => outcomes[index++] as TerminalOutcome,
    });

    const result = await service.verifyGame(GAME_ID);

    expect(verifyUrl).toHaveBeenCalledTimes(4);
    expect(result.plan.verificationResults.map(({ classification }) => classification)).toEqual([
      "unsafe",
      "broken",
      "unknown",
      "verified",
    ]);
  });

  it("stops after an operation-level verifier failure", async () => {
    const platformError = new LinkVerificationError(
      "local_platform_unavailable",
      "Local verification platform is unavailable",
    );
    let call = 0;
    const { service, verifyUrl, writePlan } = harness({
      links: [snapshot(1), snapshot(2), snapshot(3)],
      verifyUrl: async () => {
        call += 1;
        if (call === 2) throw platformError;
        return outcome();
      },
    });

    await expect(service.verifyGame(GAME_ID, { dryRun: false })).rejects.toBe(platformError);
    expect(verifyUrl).toHaveBeenCalledTimes(2);
    expect(writePlan).not.toHaveBeenCalled();
  });

  it("propagates a write failure after one complete verification pipeline", async () => {
    const writeError = new LinkVerificationError(
      "write_failed",
      "Unable to write link verification data",
    );
    const { service, verifyUrl, writePlan } = harness({
      links: [snapshot(1), snapshot(2)],
    });
    writePlan.mockRejectedValueOnce(writeError);

    await expect(service.verifyGame(GAME_ID, { dryRun: false })).rejects.toBe(writeError);
    expect(verifyUrl).toHaveBeenCalledTimes(2);
    expect(writePlan).toHaveBeenCalledOnce();
  });
});
