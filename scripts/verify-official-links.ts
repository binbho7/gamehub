import { lookup as nodeLookup } from "node:dns/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { GetPlatformProxyOptions } from "wrangler";
import { createDatabase } from "../lib/db/client";
import { createLinkVerificationStore } from "../lib/db/repositories/link-verification";
import { createSafeDestinationResolver } from "../lib/verifiers/official-links/destination";
import {
  LinkVerificationError,
  type LinkVerificationOperationCode,
} from "../lib/verifiers/official-links/errors";
import { normalizeCanonicalGameId } from "../lib/verifiers/official-links/input";
import { presentGameLinkVerificationResult } from "../lib/verifiers/official-links/presentation";
import { executeRedirectChain } from "../lib/verifiers/official-links/redirect";
import {
  createLinkVerificationService,
  type LinkVerificationService,
} from "../lib/verifiers/official-links/service";
import { requestHeaders } from "../lib/verifiers/official-links/transport";
import type {
  GameLinkVerificationResult,
  PresentedGameLinkVerificationResult,
} from "../lib/verifiers/official-links/types";
import { verifyUrl } from "../lib/verifiers/official-links/verifier";

export type VerifyOfficialLinksCliArgs = {
  gameId: number;
  write: boolean;
  json: boolean;
};

export type LinkVerificationPlatform = {
  env: { DB: AnyD1Database };
  dispose(): Promise<void> | void;
};

export type VerifyOfficialLinksCliDependencies = {
  platformFactory(): Promise<LinkVerificationPlatform>;
  serviceFactory(database: AnyD1Database): LinkVerificationService;
  present(result: GameLinkVerificationResult): PresentedGameLinkVerificationResult;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export type VerifyOfficialLinksMainDependencies = Omit<
  VerifyOfficialLinksCliDependencies,
  "platformFactory"
> & {
  loadPlatformProxy(): Promise<(
    options: GetPlatformProxyOptions,
  ) => Promise<LinkVerificationPlatform>>;
};

const localOnlyOptionPrefixes = [
  "--remote",
  "--env",
  "--config",
  "--database-id",
  "--url",
] as const;

const operationMessages: Record<LinkVerificationOperationCode, string> = {
  invalid_game_id: "Invalid canonical GameHub game ID",
  game_not_found: "Canonical GameHub game was not found",
  link_limit_exceeded: "Canonical game has too many official links to verify",
  database_unavailable: "Unable to read link verification data",
  local_platform_unavailable: "Local link verification platform is unavailable",
  write_failed: "Unable to write link verification data",
  cleanup_failed: "Unable to clean up local link verification resources",
  unexpected_error: "Unexpected official link verification failure",
};

function isLocalOnlyOption(argument: string): boolean {
  return argument === "-e" || localOnlyOptionPrefixes.some((option) => (
    argument === option || argument.startsWith(`${option}=`)
  ));
}

export function parseVerifyOfficialLinksArgs(argv: string[]): VerifyOfficialLinksCliArgs {
  const gameIds: string[] = [];
  let write = false;
  let json = false;

  for (const argument of argv) {
    if (argument === "--write") {
      if (write) throw new Error("Duplicate --write option");
      write = true;
      continue;
    }

    if (argument === "--json") {
      if (json) throw new Error("Duplicate --json option");
      json = true;
      continue;
    }

    if (isLocalOnlyOption(argument)) {
      throw new Error("Only fixed local D1 execution is supported");
    }

    if (argument.startsWith("-") && !/^-\d/.test(argument)) {
      throw new Error("Unknown option");
    }

    gameIds.push(argument);
  }

  if (gameIds.length !== 1) {
    throw new Error("Expected exactly one canonical GameHub game ID");
  }

  return {
    gameId: normalizeCanonicalGameId(gameIds[0]),
    write,
    json,
  };
}

export function createLocalLinkVerificationPlatform<Platform>(
  getPlatformProxy: (options: GetPlatformProxyOptions) => Promise<Platform>,
): Promise<Platform> {
  return getPlatformProxy({
    configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    persist: true,
    remoteBindings: false,
  });
}

function publicOperationError(error: unknown): LinkVerificationError {
  if (error instanceof LinkVerificationError) {
    return new LinkVerificationError(error.code, operationMessages[error.code]);
  }

  return new LinkVerificationError(
    "unexpected_error",
    operationMessages.unexpected_error,
  );
}

function formatCliError(error: unknown, json: boolean): string {
  const safeError = publicOperationError(error);
  return json
    ? JSON.stringify({ error: safeError.toJSON() }, null, 2)
    : `Official link verification failed (${safeError.code}): ${safeError.message}`;
}

function writeStderr(stderr: (message: string) => void, message: string): void {
  try {
    stderr(message);
  } catch {
    // The requested failure exit must not be replaced by an output-sink failure.
  }
}

function pluralized(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatHumanResult(result: PresentedGameLinkVerificationResult): string {
  const links = result.links.length === 0
    ? ["Links: none"]
    : [
        "Links:",
        ...result.links.map((link) => (
          `- #${link.linkId} ${link.classification} (${link.code}): ${link.originalUrl}`
        )),
      ];
  const updates = result.planItems.filter((item) => item.action === "update").length;
  const skips = result.planItems.length - updates;

  return [
    `Official link verification ${result.dryRun ? "dry-run" : "write"} for GameHub game ${result.gameId}`,
    `Status: ${result.status}`,
    ...links,
    `Plan: ${pluralized(updates, "update")}, ${pluralized(skips, "skip")}`,
    `Affected rows: ${result.affectedRows}`,
    `Conflicts: ${result.conflicts.length}`,
  ].join("\n");
}

function formatCliResult(
  result: PresentedGameLinkVerificationResult,
  json: boolean,
): string {
  return json ? JSON.stringify(result, null, 2) : formatHumanResult(result);
}

export async function runVerifyOfficialLinksCli(
  args: VerifyOfficialLinksCliArgs,
  dependencies: VerifyOfficialLinksCliDependencies,
): Promise<number> {
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));
  let platform: LinkVerificationPlatform | undefined;
  let operation:
    | { ok: true; result: GameLinkVerificationResult }
    | { ok: false; error: unknown };

  try {
    try {
      platform = await dependencies.platformFactory();
    } catch (cause) {
      throw new LinkVerificationError(
        "local_platform_unavailable",
        operationMessages.local_platform_unavailable,
        { cause },
      );
    }
    const service = dependencies.serviceFactory(platform.env.DB);
    const result = await service.verifyGame(args.gameId, { dryRun: !args.write });
    operation = { ok: true, result };
  } catch (error) {
    operation = { ok: false, error };
  }

  let cleanupFailed = false;
  if (platform !== undefined) {
    try {
      await platform.dispose();
    } catch {
      cleanupFailed = true;
    }
  }

  if (!operation.ok) {
    writeStderr(stderr, formatCliError(operation.error, args.json));
    return 1;
  }

  let presented: PresentedGameLinkVerificationResult;
  try {
    presented = dependencies.present(operation.result);
  } catch (error) {
    writeStderr(stderr, formatCliError(error, args.json));
    return 1;
  }

  if (cleanupFailed) {
    const error = new LinkVerificationError(
      "cleanup_failed",
      operationMessages.cleanup_failed,
    );
    if (args.write && presented.conflicts.length > 0) {
      try {
        stdout(formatCliResult(presented, args.json));
      } catch {
        // Cleanup remains a failure even when its diagnostic result cannot be written.
      }
    }
    writeStderr(stderr, formatCliError(error, args.json));
    return 1;
  }

  try {
    stdout(formatCliResult(presented, args.json));
    return args.write && presented.conflicts.length > 0 ? 1 : 0;
  } catch (error) {
    writeStderr(stderr, formatCliError(error, args.json));
    return 1;
  }
}

function createDefaultService(database: AnyD1Database): LinkVerificationService {
  const resolveDestination = createSafeDestinationResolver({
    lookup: async (hostname, options) => {
      const addresses = await nodeLookup(hostname, options);
      return addresses.map(({ address, family }) => {
        if (family !== 4 && family !== 6) {
          throw new Error("Unsupported DNS address family");
        }
        return { address, family };
      });
    },
  });
  const executeChain = (
    exactUrl: Parameters<typeof executeRedirectChain>[0],
    method: Parameters<typeof executeRedirectChain>[1],
    options?: Parameters<typeof executeRedirectChain>[3],
  ) => executeRedirectChain(exactUrl, method, {
    resolveDestination,
    request: requestHeaders,
    now: () => new Date(),
  }, options);
  const verifyBoundUrl = (
    exactUrl: Parameters<typeof verifyUrl>[0],
    options?: Parameters<typeof verifyUrl>[2],
  ) => verifyUrl(exactUrl, { executeChain }, options);

  return createLinkVerificationService({
    store: createLinkVerificationStore(createDatabase(database)),
    verifyUrl: verifyBoundUrl,
  });
}

export async function runVerifyOfficialLinksMain(
  argv: string[],
  dependencies: VerifyOfficialLinksMainDependencies,
): Promise<number> {
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));
  let args: VerifyOfficialLinksCliArgs;
  try {
    args = parseVerifyOfficialLinksArgs(argv);
  } catch (error) {
    writeStderr(stderr, formatCliError(error, argv.includes("--json")));
    return 1;
  }

  return runVerifyOfficialLinksCli(args, {
    platformFactory: async () => {
      const getPlatformProxy = await dependencies.loadPlatformProxy();
      return createLocalLinkVerificationPlatform(getPlatformProxy);
    },
    serviceFactory: dependencies.serviceFactory,
    present: dependencies.present,
    stdout: dependencies.stdout,
    stderr,
  });
}

async function main(argv: string[]): Promise<number> {
  return runVerifyOfficialLinksMain(argv, {
    loadPlatformProxy: async () => {
      const { getPlatformProxy } = await import("wrangler");
      return (options) => getPlatformProxy<{ DB: AnyD1Database }>(options);
    },
    serviceFactory: createDefaultService,
    present: presentGameLinkVerificationResult,
  });
}

export function handleVerifyOfficialLinksEntrypointFailure(
  stderr: (message: string) => void = (message) => console.error(message),
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): void {
  setExitCode(1);
  writeStderr(
    stderr,
    "Official link verification failed (unexpected_error): " +
      operationMessages.unexpected_error,
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => handleVerifyOfficialLinksEntrypointFailure());
}
