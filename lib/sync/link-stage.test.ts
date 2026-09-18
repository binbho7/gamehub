import { expect, it, vi } from "vitest";
import { createLinkStage } from "./link-stage";
import { stageError } from "./stages";
import { LinkVerificationError } from "../verifiers/official-links/errors";
import { VerifierServiceError } from "../verifiers/official-links/remote/errors";
import { createLinkVerificationService } from "../verifiers/official-links/service";
import type {
  GameLinkVerificationResult,
  VerificationClassification,
  VerificationCode,
} from "../verifiers/official-links/types";

function linkResult(
  code: VerificationCode = "http_result",
  classification: VerificationClassification = "broken",
  overrides: Partial<GameLinkVerificationResult> = {},
): GameLinkVerificationResult {
  return {
    gameId: 41,
    dryRun: true,
    status: "planned",
    affectedRows: 0,
    conflicts: [],
    plan: {
      gameId: 41,
      dryRun: true,
      linksRead: 1,
      items: [],
      verificationResults: [{
        gameId: 41,
        linkId: 1,
        originalUrl: "https://example.com/?token=secret",
        code,
        classification,
        httpStatus: 404,
        finalUrl: null,
        attempts: [],
        redirectChain: [],
        checkedAt: new Date(0),
      }],
    },
    ...overrides,
  };
}

it("keeps HTTP diagnostics successful but fails transport codes first", async () => {
  const verifyGame = vi.fn().mockResolvedValue(linkResult());
  await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
    .resolves.toEqual({ summary: "Links planned; checked=1; broken=1." });

  verifyGame.mockResolvedValue(linkResult("dns_failure"));
  await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
    .rejects.toEqual(stageError("links", "dns_failure"));

  for (const code of [
    "invalid_url", "unsupported_scheme", "unsafe_destination", "timeout", "network_error",
    "tls_error", "redirect_loop", "too_many_redirects", "invalid_redirect", "protocol_downgrade",
  ] as const) {
    verifyGame.mockResolvedValue(linkResult(code));
    await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
      .rejects.toEqual(stageError("links", code));
  }
});

it("treats all native HTTP classifications as diagnostics", async () => {
  const verifyGame = vi.fn();
  for (const classification of [
    "verified", "reachable_but_unverified", "broken", "temporarily_unavailable", "unsafe", "unknown",
  ] as const) {
    verifyGame.mockResolvedValue(linkResult("http_result", classification));
    await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
      .resolves.toMatchObject({ summary: expect.stringContaining(`Links planned; checked=1; ${classification}=1.`) });
  }
});

it("prioritizes conflicts and partial application over result codes", async () => {
  const conflicted = linkResult("http_result", "verified", {
    dryRun: false,
    conflicts: [{ linkId: 1, code: "write_conflict" }],
    status: "applied",
  });
  conflicted.plan.dryRun = false;
  await expect(createLinkStage({ verifyGame: vi.fn().mockResolvedValue(conflicted) })
    .execute(41, { dryRun: false })).rejects.toEqual(stageError("links", "write_conflict"));

  const partial = linkResult("http_result", "verified", {
    dryRun: false,
    status: "partially_applied",
  });
  partial.plan.dryRun = false;
  await expect(createLinkStage({ verifyGame: vi.fn().mockResolvedValue(partial) })
    .execute(41, { dryRun: false })).rejects.toEqual(stageError("links", "partially_applied"));
});

it("passes empty and manual-only plans without editing them", async () => {
  const result = linkResult();
  result.plan.verificationResults = [];
  result.plan.linksRead = 0;
  await expect(createLinkStage({ verifyGame: vi.fn().mockResolvedValue(result) })
    .execute(41, { dryRun: true })).resolves.toEqual({ summary: "Links planned; checked=0." });

  const manual = linkResult();
  manual.plan.items = [{
    action: "skip",
    linkId: 1,
    originalUrl: "https://manual.example/",
    reason: "manual_verification_preserved",
  }];
  await expect(createLinkStage({ verifyGame: vi.fn().mockResolvedValue(manual) })
    .execute(41, { dryRun: true })).resolves.toEqual({ summary: "Links planned; checked=1; broken=1." });
  expect(manual.plan.items[0]).toMatchObject({ reason: "manual_verification_preserved" });
});

it("preserves manual metadata through the real verifier service and planner", async () => {
  const manual = {
    id: 9,
    gameId: 41,
    url: "https://manual.example/store",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    verificationStatus: "verified" as const,
    verificationMethod: "manual" as const,
    httpStatus: 200,
    redirectUrl: null,
    verifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastCheckedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
  const before = structuredClone(manual);
  const service = createLinkVerificationService({
    store: {
      readGameLinks: async () => ({ gameExists: true, links: [manual] }),
      writePlan: async () => ({ affectedRows: 0, appliedLinkIds: [], conflicts: [] }),
    },
    verifyUrl: async () => ({
      code: "http_result",
      attempts: [],
      redirectChain: [],
      finalUrl: "https://manual.example/store",
      httpStatus: 500,
      checkedAt: new Date("2026-09-02T00:00:00.000Z"),
    }),
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });

  const verifierResult = await service.verifyGame(41, { dryRun: true });
  expect(verifierResult.plan.items).toEqual([{
    action: "skip",
    linkId: 9,
    originalUrl: manual.url,
    reason: "manual_verification_preserved",
  }]);
  await expect(createLinkStage(service).execute(41, { dryRun: true }))
    .resolves.toEqual({ summary: "Links planned; checked=1; temporarily_unavailable=1." });
  expect(manual).toEqual(before);
});

it("validates identity, mode, status, classifications, and codes", async () => {
  const cases: Array<[string, Partial<GameLinkVerificationResult>]> = [
    ["invalid_result", { gameId: 42 }],
    ["invalid_result", { dryRun: false }],
    ["invalid_result", { status: "wat" as GameLinkVerificationResult["status"] }],
  ];
  for (const [code, overrides] of cases) {
    await expect(createLinkStage({ verifyGame: vi.fn().mockResolvedValue(linkResult("http_result", "verified", overrides)) })
      .execute(41, { dryRun: true })).rejects.toEqual(stageError("links", code as "invalid_result"));
  }
  const badClassification = linkResult("http_result", "verified");
  (badClassification.plan.verificationResults[0] as unknown as { classification: string }).classification = "failed";
  await expect(createLinkStage({ verifyGame: vi.fn().mockResolvedValue(badClassification) })
    .execute(41, { dryRun: true })).rejects.toEqual(stageError("links", "invalid_result"));
  const badCode = linkResult("http_result");
  (badCode.plan.verificationResults[0] as unknown as { code: string }).code = "secret";
  await expect(createLinkStage({ verifyGame: vi.fn().mockResolvedValue(badCode) })
    .execute(41, { dryRun: true })).rejects.toEqual(stageError("links", "invalid_result"));
});

it("maps verifier errors without exposing raw text", async () => {
  const verifyGame = vi.fn().mockRejectedValue(
    new LinkVerificationError("write_failed", "token=secret"),
  );
  await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
    .rejects.toEqual(stageError("links", "write_failed"));
  verifyGame.mockRejectedValue(new LinkVerificationError("cleanup_failed", "secret"));
  await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
    .rejects.toEqual(stageError("links", "cleanup_failed"));
  verifyGame.mockRejectedValue({ code: "write_failed", message: "token=secret" });
  await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
    .rejects.toEqual(stageError("links", "unexpected_error"));
  verifyGame.mockRejectedValue(new Error("token=secret"));
  await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
    .rejects.toEqual(stageError("links", "unexpected_error"));
});

it("forwards exact game id and dry-run mode", async () => {
  const result = linkResult();
  result.dryRun = false;
  result.plan.dryRun = false;
  const verifyGame = vi.fn().mockResolvedValue(result);
  await createLinkStage({ verifyGame }).execute(41, { dryRun: false });
  expect(verifyGame).toHaveBeenCalledWith(41, { dryRun: false });
});

it("accepts only branded remote service failures and discards untrusted messages", async () => {
  for (const code of ["verifier_service_unavailable", "verifier_timeout", "verifier_protocol_error", "verifier_auth_error", "verifier_invalid_response"] as const) {
    await expect(createLinkStage({ verifyGame: async () => { throw new VerifierServiceError(code); } }).execute(41, { dryRun: true })).rejects.toEqual(stageError("links", code));
    await expect(createLinkStage({ verifyGame: async () => { throw { code, message: "secret" }; } }).execute(41, { dryRun: true })).rejects.toEqual(stageError("links", "unexpected_error"));
  }
});
