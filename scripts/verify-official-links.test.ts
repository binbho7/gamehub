import type { AnyD1Database } from "drizzle-orm/d1";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LinkVerificationError } from "../lib/verifiers/official-links/errors";
import { presentGameLinkVerificationResult } from "../lib/verifiers/official-links/presentation";
import type {
  GameLinkVerificationResult,
  PresentedGameLinkVerificationResult,
  VerificationClassification,
  VerificationCode,
} from "../lib/verifiers/official-links/types";
import {
  createLocalLinkVerificationPlatform,
  parseVerifyOfficialLinksArgs,
  runVerifyOfficialLinksCli,
  type LinkVerificationPlatform,
} from "./verify-official-links";

const date = new Date("2026-09-06T01:02:03.000Z");

function secretUrl(surface: string, token: string): string {
  return `https://${surface}-user:${surface}-password@example.com/${surface}` +
    `?token=${token}&safe=${surface}#${surface}-fragment`;
}

function resultWithClassifications(
  classifications: Array<{
    classification: VerificationClassification;
    code: VerificationCode;
  }>,
  options: {
    dryRun?: boolean;
    status?: GameLinkVerificationResult["status"];
    affectedRows?: number;
    conflicts?: GameLinkVerificationResult["conflicts"];
  } = {},
): GameLinkVerificationResult {
  const verificationResults = classifications.map(({ classification, code }, index) => {
    const linkId = index + 1;
    return {
      linkId,
      gameId: 42,
      originalUrl: secretUrl(`original-${linkId}`, `original-token-${linkId}`),
      classification,
      code,
      attempts: [{
        method: "HEAD" as const,
        url: secretUrl(`attempt-${linkId}`, `attempt-token-${linkId}`),
        resolvedAddress: classification === "unsafe" ? null : "93.184.216.34",
        addressFamily: classification === "unsafe" ? null : 4 as const,
        httpStatus: classification === "broken" ? 404 : null,
        startedAt: date,
        finishedAt: date,
      }],
      redirectChain: [{
        fromUrl: secretUrl(`redirect-from-${linkId}`, `from-token-${linkId}`),
        status: 302 as const,
        location: secretUrl(`location-${linkId}`, `location-token-${linkId}`),
        resolvedUrl: secretUrl(`resolved-${linkId}`, `resolved-token-${linkId}`),
      }],
      finalUrl: secretUrl(`final-${linkId}`, `final-token-${linkId}`),
      httpStatus: classification === "broken" ? 404 : null,
      checkedAt: date,
    };
  });

  const dryRun = options.dryRun ?? true;
  return {
    gameId: 42,
    dryRun,
    status: options.status ?? (dryRun ? "planned" : "applied"),
    plan: {
      gameId: 42,
      dryRun,
      linksRead: verificationResults.length,
      verificationResults,
      items: verificationResults.map((result) => ({
        action: "update" as const,
        snapshot: {
          id: result.linkId,
          gameId: 42,
          url: secretUrl(`plan-${result.linkId}`, `plan-token-${result.linkId}`),
          updatedAt: date,
          verificationStatus: "unverified" as const,
          verificationMethod: null,
          httpStatus: null,
          redirectUrl: null,
          verifiedAt: null,
          lastCheckedAt: null,
        },
        changes: {
          verificationStatus: result.classification,
          verificationMethod: "http" as const,
          httpStatus: result.httpStatus,
          redirectUrl: secretUrl(
            `plan-redirect-${result.linkId}`,
            `plan-redirect-token-${result.linkId}`,
          ),
          verifiedAt: null,
          lastCheckedAt: date,
          updatedAt: date,
        },
      })),
    },
    affectedRows: options.affectedRows ?? 0,
    conflicts: options.conflicts ?? [],
  };
}

const completedOutcomes = resultWithClassifications([
  { classification: "broken", code: "invalid_redirect" },
  { classification: "unsafe", code: "unsafe_destination" },
  { classification: "unknown", code: "tls_error" },
]);

function dependenciesFor(
  outcome: GameLinkVerificationResult | Promise<never>,
  output: {
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
    present?: (result: GameLinkVerificationResult) => PresentedGameLinkVerificationResult;
  } = {},
) {
  const database = { kind: "local-d1" } as unknown as AnyD1Database;
  const platform: LinkVerificationPlatform = {
    env: { DB: database },
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const verifyGame = outcome instanceof Promise
    ? vi.fn().mockReturnValue(outcome)
    : vi.fn().mockResolvedValue(outcome);

  return {
    database,
    platform,
    verifyGame,
    dependencies: {
      platformFactory: vi.fn().mockResolvedValue(platform),
      serviceFactory: vi.fn().mockReturnValue({ verifyGame }),
      present: output.present ?? presentGameLinkVerificationResult,
      stdout: output.stdout ?? vi.fn<(message: string) => void>(),
      stderr: output.stderr ?? vi.fn<(message: string) => void>(),
    },
  };
}

function renderedOutput(spy: ReturnType<typeof vi.fn>): string {
  return spy.mock.calls.flat().join("\n");
}

function expectNoInternalSecret(output: string): void {
  expect(output).not.toMatch(
    /(?:original|attempt|redirect-from|location|resolved|final|plan|plan-redirect)-(?:user|password|fragment|token)/,
  );
  expect(output).not.toContain("original-token");
  expect(output).not.toContain("attempt-token");
  expect(output).not.toContain("location-token");
  expect(output).not.toContain("resolved-token");
  expect(output).not.toContain("final-token");
  expect(output).not.toContain("plan-token");
  expect(output).not.toContain("plan-redirect-token");
}

describe("parseVerifyOfficialLinksArgs", () => {
  it("defaults exactly one positive canonical game ID to dry-run human output", () => {
    expect(parseVerifyOfficialLinksArgs(["42"])).toEqual({
      gameId: 42,
      write: false,
      json: false,
    });
  });

  it.each([
    [["42", "--write"], { gameId: 42, write: true, json: false }],
    [["--write", "42"], { gameId: 42, write: true, json: false }],
    [["42", "--json"], { gameId: 42, write: false, json: true }],
    [["--json", "42"], { gameId: 42, write: false, json: true }],
    [["--json", "42", "--write"], { gameId: 42, write: true, json: true }],
    [["--write", "42", "--json"], { gameId: 42, write: true, json: true }],
  ])("accepts each execution flag once in either order: %j", (argv, expected) => {
    expect(parseVerifyOfficialLinksArgs(argv)).toEqual(expected);
  });

  it.each([
    ["duplicate --write", ["42", "--write", "--write"]],
    ["duplicate --json", ["42", "--json", "--json"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseVerifyOfficialLinksArgs(argv)).toThrow(/duplicate/i);
  });

  it.each([
    ["missing ID", []],
    ["flags without an ID", ["--write", "--json"]],
    ["multiple IDs", ["42", "43"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseVerifyOfficialLinksArgs(argv)).toThrow(/exactly one.*game.*id/i);
  });

  it.each(["0", "-1", "1.5", "not-a-game-id", "9007199254740992"])(
    "rejects invalid canonical game ID %s",
    (gameId) => {
      expect(() => parseVerifyOfficialLinksArgs([gameId])).toThrowError(
        expect.objectContaining({ code: "invalid_game_id" }),
      );
    },
  );

  it.each([
    "--remote",
    "--remote=production",
    "--env",
    "--env=production",
    "-e",
    "--config",
    "--config=wrangler.remote.jsonc",
    "--database-id",
    "--database-id=secret-database-id",
    "--url",
    "--url=https://remote.example.test/?token=secret-url-token",
  ])("rejects non-local option without reflecting its value: %s", (option) => {
    const error = (() => {
      try {
        parseVerifyOfficialLinksArgs(["42", option]);
      } catch (caught) {
        return caught;
      }
      throw new Error("Expected argument parsing to fail");
    })();

    expect(String(error)).toMatch(/fixed local|not supported/i);
    if (option.includes("=")) {
      expect(String(error)).not.toContain(option.slice(option.indexOf("=") + 1));
    }
  });

  it.each(["--unknown", "--write=true", "--json=true", "-x"])(
    "rejects unknown option without echoing it: %s",
    (option) => {
      const error = (() => {
        try {
          parseVerifyOfficialLinksArgs(["42", option]);
        } catch (caught) {
          return caught;
        }
        throw new Error("Expected argument parsing to fail");
      })();

      expect(String(error)).toMatch(/unknown option/i);
      expect(String(error)).not.toContain(option);
    },
  );

  it("rejects an arbitrary name=value option without exposing its secret", () => {
    const secret = "parser-assignment-secret";
    const error = (() => {
      try {
        parseVerifyOfficialLinksArgs(["42", `--proxy-url=https://example.com/?token=${secret}`]);
      } catch (caught) {
        return caught;
      }
      throw new Error("Expected argument parsing to fail");
    })();

    expect(String(error)).toMatch(/unknown option/i);
    expect(String(error)).not.toContain(secret);
  });
});

describe("createLocalLinkVerificationPlatform", () => {
  it("uses only the fixed repository config and persistent local bindings", async () => {
    const platform = { env: { DB: {} }, dispose: vi.fn() };
    const getPlatformProxy = vi.fn().mockResolvedValue(platform);

    const created = await createLocalLinkVerificationPlatform(getPlatformProxy);

    expect(created).toBe(platform);
    expect(getPlatformProxy).toHaveBeenCalledOnce();
    expect(getPlatformProxy).toHaveBeenCalledWith({
      configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      persist: true,
      remoteBindings: false,
    });
  });
});

describe("runVerifyOfficialLinksCli", () => {
  it.each([
    { write: false, dryRun: true },
    { write: true, dryRun: false },
  ])("creates and disposes local D1 with dryRun=$dryRun", async ({ write, dryRun }) => {
    const result = resultWithClassifications([], {
      dryRun,
      status: dryRun ? "planned" : "applied",
    });
    const harness = dependenciesFor(result);

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.dependencies.platformFactory).toHaveBeenCalledOnce();
    expect(harness.dependencies.serviceFactory).toHaveBeenCalledWith(harness.database);
    expect(harness.verifyGame).toHaveBeenCalledWith(42, { dryRun });
    expect(harness.platform.dispose).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "returns success for completed broken, unsafe, and unknown outcomes with json=%s",
    async (json) => {
      const stdout = vi.fn();
      const stderr = vi.fn();
      const present = vi.fn(presentGameLinkVerificationResult);
      const harness = dependenciesFor(completedOutcomes, { stdout, stderr, present });

      const exitCode = await runVerifyOfficialLinksCli(
        { gameId: 42, write: false, json },
        harness.dependencies,
      );

      expect(exitCode).toBe(0);
      expect(present).toHaveBeenCalledOnce();
      expect(present).toHaveBeenCalledWith(completedOutcomes);
      expect(stderr).not.toHaveBeenCalled();
      const output = renderedOutput(stdout);
      expect(output).toContain("broken");
      expect(output).toContain("unsafe");
      expect(output).toContain("unknown");
      expectNoInternalSecret(output);
      expect(output).not.toContain("-user:");
      expect(output).not.toContain("-password@");
      expect(output).not.toContain("-fragment");
    },
  );

  it("serializes only the DTO returned by the common presentation boundary", async () => {
    const presented: PresentedGameLinkVerificationResult = {
      gameId: 9001,
      dryRun: true,
      status: "planned",
      links: [],
      planItems: [],
      affectedRows: 0,
      conflicts: [],
    };
    const present = vi.fn().mockReturnValue(presented);
    const stdout = vi.fn();
    const harness = dependenciesFor(completedOutcomes, { present, stdout });

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: false, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(present).toHaveBeenCalledWith(completedOutcomes);
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(presented, null, 2));
    expect(renderedOutput(stdout)).not.toContain("original-token-1");
  });

  it.each([false, true])("fails closed when malformed URLs reach presentation with json=%s", async (json) => {
    const malformed = "https://[malformed-secret/path?token=malformed-secret#malformed-fragment";
    const result = resultWithClassifications([
      { classification: "unsafe", code: "invalid_url" },
    ]);
    result.plan.verificationResults[0].originalUrl = malformed;
    result.plan.verificationResults[0].attempts[0].url = malformed;
    result.plan.verificationResults[0].redirectChain[0].location = malformed;
    result.plan.verificationResults[0].redirectChain[0].resolvedUrl = malformed;
    result.plan.verificationResults[0].finalUrl = malformed;
    const item = result.plan.items[0];
    if (item.action === "update") {
      item.snapshot.url = malformed;
      item.changes.redirectUrl = malformed;
    }
    const stdout = vi.fn();
    const harness = dependenciesFor(result, { stdout });

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: false, json },
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    const output = renderedOutput(stdout);
    expect(output).not.toContain("malformed-secret");
    expect(output).not.toContain("malformed-fragment");
    if (json) expect(output).toContain("[REDACTED_URL]");
  });

  it("returns failure for a write conflict while preserving sanitized counts in JSON", async () => {
    const result = resultWithClassifications([
      { classification: "broken", code: "http_result" },
      { classification: "unknown", code: "dns_failure" },
    ], {
      dryRun: false,
      status: "partially_applied",
      affectedRows: 1,
      conflicts: [{ linkId: 2, code: "write_conflict" }],
    });
    const stdout = vi.fn();
    const harness = dependenciesFor(result, { stdout });

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: true, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(renderedOutput(stdout)) as PresentedGameLinkVerificationResult;
    expect(parsed).toMatchObject({
      status: "partially_applied",
      affectedRows: 1,
      conflicts: [{ linkId: 2, code: "write_conflict" }],
    });
    expectNoInternalSecret(renderedOutput(stdout));
  });

  it.each([
    ["database", new LinkVerificationError(
      "database_unavailable",
      "Unable to read link verification data",
      { cause: new Error("raw D1 operation secret SELECT * FROM secret_table") },
    )],
    ["write", new LinkVerificationError(
      "write_failed",
      "Unable to write link verification data",
      { cause: new Error("raw D1 write secret UPDATE secret_table") },
    )],
    ["unexpected", Object.assign(
      new Error("raw DNS operation secret getaddrinfo ENOTFOUND"),
      {
        stack: "secret stack trace",
        certificate: "-----BEGIN CERTIFICATE----- secret certificate material",
        tls: "raw TLS alert secret",
        env: { DATABASE_TOKEN: "secret environment value" },
      },
    )],
  ])("returns one sanitized failure for %s operation errors", async (_name, error) => {
    const stderr = vi.fn();
    const harness = dependenciesFor(Promise.reject(error), { stderr });

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: true, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.platform.dispose).toHaveBeenCalledOnce();
    const output = renderedOutput(stderr);
    expect(output).not.toMatch(/operation secret|secret_table|SELECT \*|UPDATE /);
    expect(output).not.toMatch(/getaddrinfo|ENOTFOUND|raw TLS|BEGIN CERTIFICATE/);
    expect(output).not.toMatch(/stack trace|DATABASE_TOKEN|environment value/);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("maps platform failure to a constant local-only error without cleanup", async () => {
    const stderr = vi.fn();
    const harness = dependenciesFor(completedOutcomes, { stderr });
    harness.dependencies.platformFactory.mockRejectedValue(Object.assign(
      new Error("wrangler platform secret"),
      { stack: "platform secret stack", env: { TOKEN: "platform-env-secret" } },
    ));

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: false, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.platform.dispose).not.toHaveBeenCalled();
    expect(renderedOutput(stderr)).toContain("local_platform_unavailable");
    expect(renderedOutput(stderr)).not.toMatch(/platform secret|platform-env-secret/);
  });

  it("turns cleanup failure after success into a sanitized cleanup_failed error", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const harness = dependenciesFor(completedOutcomes, { stdout, stderr });
    harness.platform.dispose = vi.fn().mockRejectedValue(Object.assign(
      new Error("cleanup operation secret"),
      {
        stack: "cleanup secret stack",
        certificate: "-----BEGIN CERTIFICATE----- cleanup-cert-secret",
        env: { TOKEN: "cleanup-env-secret" },
      },
    ));

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: false, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const output = renderedOutput(stderr);
    expect(output).toContain("cleanup_failed");
    expect(output).not.toMatch(/operation secret|stack|BEGIN CERTIFICATE|cleanup-env-secret/);
  });

  it("keeps the primary typed failure when cleanup also fails", async () => {
    const operation = new LinkVerificationError(
      "write_failed",
      "Unable to write link verification data",
      { cause: new Error("primary-write-secret") },
    );
    const stderr = vi.fn();
    const harness = dependenciesFor(Promise.reject(operation), { stderr });
    harness.platform.dispose = vi.fn().mockRejectedValue(new Error("cleanup-secondary-secret"));

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: true, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    const output = renderedOutput(stderr);
    expect(output).toContain("write_failed");
    expect(output).not.toMatch(/primary-write-secret|cleanup-secondary-secret/);
  });

  it("fails closed when the presentation boundary itself rejects an unsafe DTO", async () => {
    const stderr = vi.fn();
    const present = vi.fn(() => {
      throw Object.assign(new Error("presentation secret"), {
        stack: "presentation stack secret",
      });
    });
    const harness = dependenciesFor(completedOutcomes, { stderr, present });

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: false, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(renderedOutput(stderr)).toContain("unexpected_error");
    expect(renderedOutput(stderr)).not.toMatch(/presentation secret|stack secret/);
  });
});
