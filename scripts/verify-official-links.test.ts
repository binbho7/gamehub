import type { AnyD1Database } from "drizzle-orm/d1";
import { readFileSync } from "node:fs";
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
  handleVerifyOfficialLinksEntrypointFailure,
  parseVerifyOfficialLinksArgs,
  runVerifyOfficialLinksCli,
  runVerifyOfficialLinksMain,
  type LinkVerificationPlatform,
} from "./verify-official-links";

const date = new Date("2026-09-06T01:02:03.000Z");

const v25ReadmeSection = (() => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const heading = "## V2.5 local official-link verification";
  const start = readme.indexOf(heading);
  if (start === -1) return "";

  const section = readme.slice(start);
  const nextHeading = section.indexOf("\n## ", heading.length);
  return nextHeading === -1 ? section : section.slice(0, nextHeading);
})();
const v25ReadmeLines = v25ReadmeSection
  .split(/\r?\n/)
  .map((line) => line.trim());

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
  expect(output).not.toContain("from-token");
  expect(output).not.toContain("location-token");
  expect(output).not.toContain("resolved-token");
  expect(output).not.toContain("final-token");
  expect(output).not.toContain("plan-token");
  expect(output).not.toContain("plan-redirect-token");
}

describe("V2.5 README operator documentation", () => {
  it.each([
    "npm run links:verify -- 123",
    "npm run links:verify -- 123 --write",
    "npm run links:verify -- 123 --json",
    "npm run links:verify -- 123 --write --json",
  ])("documents the exact supported command: %s", (command) => {
    expect(v25ReadmeLines).toContain(command);
  });

  it("documents dry-run, write, fixed-local, and link-mutation boundaries", () => {
    expect(v25ReadmeSection).toContain("default dry-run");
    expect(v25ReadmeSection).toContain("zero D1 mutations");
    expect(v25ReadmeSection).toContain("`--write`");
    expect(v25ReadmeSection).toContain("fixed `wrangler.jsonc`");
    expect(v25ReadmeSection).toContain("`.wrangler/state`");
    expect(v25ReadmeSection).toContain("`remoteBindings: false`");
    expect(v25ReadmeSection).toContain("no remote D1 mode");
    expect(v25ReadmeSection).toContain("no Cron");
    expect(v25ReadmeSection).toContain(
      "does not discover, create, delete, replace, or rewrite links",
    );
  });

  it("documents every-hop SSRF defenses and the complete execution limits", () => {
    expect(v25ReadmeSection).toContain("all DNS addresses");
    expect(v25ReadmeSection).toContain("mixed public and unsafe answers");
    expect(v25ReadmeSection).toContain("every redirect hop");
    expect(v25ReadmeSection).toContain("HTTP port 80 and HTTPS port 443");
    expect(v25ReadmeSection).toContain("HTTPS-to-HTTP downgrades are rejected");
    expect(v25ReadmeSection).toContain("2025-10-09");
    for (const limit of [
      "20 links per game",
      "concurrency 1",
      "16 DNS results per hop",
      "3-second DNS deadline",
      "8-second request-to-headers deadline",
      "20-second total deadline per link",
      "5-minute total deadline per game",
      "5 redirects (6 total hops)",
      "16 KiB response headers",
      "2,048-character URLs and redirect locations",
      "zero application body bytes",
      "no automatic retries",
    ]) {
      expect(v25ReadmeSection).toContain(limit);
    }
  });

  it("documents classifications, manual precedence, and sanitized output", () => {
    for (const status of [
      "`verified`",
      "`reachable_but_unverified`",
      "`broken`",
      "`temporarily_unavailable`",
      "`unsafe`",
      "`unknown`",
    ]) {
      expect(v25ReadmeSection).toContain(status);
    }
    expect(v25ReadmeSection).toContain("Manual verification metadata is preserved");
    expect(v25ReadmeSection).toContain("URL query secrets are replaced with `[REDACTED]`");
    expect(v25ReadmeSection).toContain("malformed URLs become `[INVALID_URL]`");
    expect(v25ReadmeSection).toContain(
      "Successful human and JSON result output is rendered only from the presented DTO",
    );
    expect(v25ReadmeSection).toContain(
      "Operation failures use fixed public code and message mappings",
    );
  });
});

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

describe("runVerifyOfficialLinksMain", () => {
  it.each([false, true])(
    "maps Wrangler module-load failure to local_platform_unavailable with json=%s",
    async (json) => {
      const moduleSecret = "wrangler-import-secret";
      const stderr = vi.fn();
      const exitCode = await runVerifyOfficialLinksMain(
        ["42", ...(json ? ["--json"] : [])],
        {
          loadPlatformProxy: vi.fn().mockRejectedValue(Object.assign(
            new Error(`Cannot load Wrangler: ${moduleSecret}`),
            { stack: `module stack ${moduleSecret}` },
          )),
          serviceFactory: vi.fn(),
          present: presentGameLinkVerificationResult,
          stdout: vi.fn(),
          stderr,
        },
      );

      expect(exitCode).toBe(1);
      const output = renderedOutput(stderr);
      expect(output).toContain("local_platform_unavailable");
      expect(output).not.toContain(moduleSecret);
      if (json) {
        expect(JSON.parse(output)).toEqual({
          error: {
            name: "LinkVerificationError",
            code: "local_platform_unavailable",
            message: "Local link verification platform is unavailable",
          },
        });
      }
    },
  );
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
    if (json) expect(output).toContain("[INVALID_URL]");
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
    ...[false, true].flatMap((json) => [["database", json, new LinkVerificationError(
      "database_unavailable",
      "Unable to read link verification data",
      { cause: new Error("raw D1 operation secret SELECT * FROM secret_table") },
    )] as const]),
    ...[false, true].flatMap((json) => [["write", json, new LinkVerificationError(
      "write_failed",
      "Unable to write link verification data",
      { cause: new Error("raw D1 write secret UPDATE secret_table") },
    )] as const]),
    ...[false, true].flatMap((json) => [["unexpected", json, Object.assign(
      new Error("raw DNS operation secret getaddrinfo ENOTFOUND"),
      {
        stack: "secret stack trace",
        certificate: "-----BEGIN CERTIFICATE----- secret certificate material",
        tls: "raw TLS alert secret",
        env: { DATABASE_TOKEN: "secret environment value" },
      },
    )] as const]),
  ])("returns one sanitized failure for %s operation errors with json=%s", async (_name, json, error) => {
    const stderr = vi.fn();
    const harness = dependenciesFor(Promise.reject(error), { stderr });

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: true, json },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.platform.dispose).toHaveBeenCalledOnce();
    const output = renderedOutput(stderr);
    expect(output).not.toMatch(/operation secret|secret_table|SELECT \*|UPDATE /);
    expect(output).not.toMatch(/getaddrinfo|ENOTFOUND|raw TLS|BEGIN CERTIFICATE/);
    expect(output).not.toMatch(/stack trace|DATABASE_TOKEN|environment value/);
    if (json) expect(() => JSON.parse(output)).not.toThrow();
  });

  it.each([false, true])("maps platform failure to a constant local-only error without cleanup with json=%s", async (json) => {
    const stderr = vi.fn();
    const harness = dependenciesFor(completedOutcomes, { stderr });
    harness.dependencies.platformFactory.mockRejectedValue(Object.assign(
      new Error("wrangler platform secret"),
      { stack: "platform secret stack", env: { TOKEN: "platform-env-secret" } },
    ));

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: false, json },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(harness.platform.dispose).not.toHaveBeenCalled();
    expect(renderedOutput(stderr)).toContain("local_platform_unavailable");
    expect(renderedOutput(stderr)).not.toMatch(/platform secret|platform-env-secret/);
    if (json) expect(() => JSON.parse(renderedOutput(stderr))).not.toThrow();
  });

  it.each([false, true])("turns cleanup failure after success into a sanitized cleanup_failed error with json=%s", async (json) => {
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
      { gameId: 42, write: false, json },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    const output = renderedOutput(stderr);
    expect(output).toContain("cleanup_failed");
    expect(output).not.toMatch(/operation secret|stack|BEGIN CERTIFICATE|cleanup-env-secret/);
    if (json) expect(() => JSON.parse(output)).not.toThrow();
  });

  it("preserves sanitized partial-write counts when cleanup also fails", async () => {
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
    const stderr = vi.fn();
    const harness = dependenciesFor(result, { stdout, stderr });
    harness.platform.dispose = vi.fn().mockRejectedValue(Object.assign(
      new Error("cleanup-after-conflict-secret"),
      { stack: "cleanup-after-conflict-stack", env: { TOKEN: "cleanup-conflict-env" } },
    ));

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: true, json: true },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(renderedOutput(stdout))).toMatchObject({
      status: "partially_applied",
      affectedRows: 1,
      conflicts: [{ linkId: 2, code: "write_conflict" }],
    });
    expect(renderedOutput(stderr)).toContain("cleanup_failed");
    const completeOutput = `${renderedOutput(stdout)}\n${renderedOutput(stderr)}`;
    expectNoInternalSecret(completeOutput);
    expect(completeOutput).not.toMatch(
      /cleanup-after-conflict-secret|cleanup-after-conflict-stack|cleanup-conflict-env/,
    );
  });

  it.each([false, true])(
    "emits one sanitized applied write result before cleanup_failed with json=%s",
    async (json) => {
      const result = resultWithClassifications([
        { classification: "verified", code: "http_result" },
        { classification: "unknown", code: "network_error" },
      ], {
        dryRun: false,
        status: "applied",
        affectedRows: 2,
        conflicts: [],
      });
      const stdout = vi.fn();
      const stderr = vi.fn();
      const harness = dependenciesFor(result, { stdout, stderr });
      harness.platform.dispose = vi.fn().mockRejectedValue(Object.assign(
        new Error("cleanup-after-apply-secret"),
        { stack: "cleanup-after-apply-stack", env: { TOKEN: "cleanup-apply-env" } },
      ));

      const exitCode = await runVerifyOfficialLinksCli(
        { gameId: 42, write: true, json },
        harness.dependencies,
      );

      expect(exitCode).toBe(1);
      expect(stdout).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledOnce();
      expect(stdout.mock.invocationCallOrder[0]).toBeLessThan(
        stderr.mock.invocationCallOrder[0] as number,
      );
      const resultOutput = renderedOutput(stdout);
      if (json) {
        expect(JSON.parse(resultOutput)).toMatchObject({
          status: "applied",
          affectedRows: 2,
          conflicts: [],
        });
      } else {
        expect(resultOutput).toContain("Status: applied");
        expect(resultOutput).toContain("Affected rows: 2");
        expect(resultOutput).toContain("Conflicts: 0");
      }
      const errorOutput = renderedOutput(stderr);
      expect(errorOutput).toContain("cleanup_failed");
      const completeOutput = `${resultOutput}\n${errorOutput}`;
      expectNoInternalSecret(completeOutput);
      expect(completeOutput).not.toMatch(
        /cleanup-after-apply-secret|cleanup-after-apply-stack|cleanup-apply-env/,
      );
    },
  );

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

  it.each([false, true])("fails closed when the presentation boundary itself rejects an unsafe DTO with json=%s", async (json) => {
    const stderr = vi.fn();
    const present = vi.fn(() => {
      throw Object.assign(new Error("presentation secret"), {
        stack: "presentation stack secret",
      });
    });
    const harness = dependenciesFor(completedOutcomes, { stderr, present });

    const exitCode = await runVerifyOfficialLinksCli(
      { gameId: 42, write: false, json },
      harness.dependencies,
    );

    expect(exitCode).toBe(1);
    expect(renderedOutput(stderr)).toContain("unexpected_error");
    expect(renderedOutput(stderr)).not.toMatch(/presentation secret|stack secret/);
    if (json) expect(() => JSON.parse(renderedOutput(stderr))).not.toThrow();
  });

  it("returns failure even when the stderr sink throws", async () => {
    const harness = dependenciesFor(Promise.reject(new Error("operation-secret")), {
      stderr: () => {
        throw new Error("stderr-sink-secret");
      },
    });

    await expect(runVerifyOfficialLinksCli(
      { gameId: 42, write: false, json: true },
      harness.dependencies,
    )).resolves.toBe(1);
  });
});

describe("handleVerifyOfficialLinksEntrypointFailure", () => {
  it("sets the failure exit code before last-resort logging and ignores logger failure", () => {
    const events: string[] = [];

    expect(() => handleVerifyOfficialLinksEntrypointFailure(
      () => {
        events.push("stderr");
        throw new Error("last-resort-stderr-secret");
      },
      (code) => events.push(`exit:${code}`),
    )).not.toThrow();

    expect(events).toEqual(["exit:1", "stderr"]);
  });
});
