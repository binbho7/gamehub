import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { GetPlatformProxyOptions } from "wrangler";
import { createDatabase } from "../lib/db/client";
import { createIgdbEnrichmentStore } from "../lib/db/repositories/igdb-enrichment";
import type { IgdbEnrichmentResult } from "../lib/enrichers/igdb-candidate";
import { createIgdbEnricher } from "../lib/enrichers/igdb";
import { normalizeCanonicalGameId } from "../lib/enrichers/igdb-input";
import { createIgdbAuthClient } from "../lib/providers/igdb/auth-client";
import { createIgdbClient } from "../lib/providers/igdb/client";
import { IgdbError } from "../lib/providers/igdb/errors";

export type IgdbEnrichCliArgs = {
  gameId: number;
  write: boolean;
  json: boolean;
};

type IgdbEnricher = ReturnType<typeof createIgdbEnricher>;

type IgdbEnrichmentPlatform = {
  env: { DB: AnyD1Database };
  dispose(): Promise<void> | void;
};

export type IgdbEnrichCliDependencies = {
  platformFactory(): Promise<IgdbEnrichmentPlatform>;
  enricherFactory(database: AnyD1Database): Pick<IgdbEnricher, "enrichGame">;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

const localOnlyOptionPrefixes = [
  "--remote",
  "--env",
  "--config",
  "--database-id",
  "--url",
] as const;

function isLocalOnlyOption(argument: string): boolean {
  return argument === "-e" || localOnlyOptionPrefixes.some((option) => (
    argument === option || argument.startsWith(`${option}=`)
  ));
}

export function parseIgdbEnrichArgs(argv: string[]): IgdbEnrichCliArgs {
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

export function createLocalIgdbEnrichmentPlatform<Platform>(
  getPlatformProxy: (options: GetPlatformProxyOptions) => Promise<Platform>,
): Promise<Platform> {
  return getPlatformProxy({
    configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    persist: true,
    remoteBindings: false,
  });
}

function pluralized(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function formatHumanResult(result: IgdbEnrichmentResult): string {
  const { plan } = result;
  const matched = plan.matchedIgdbGame
    ? `${plan.matchedIgdbGame.name} (${plan.matchedIgdbGame.id})`
    : "none";

  return [
    `IGDB enrichment ${result.dryRun ? "dry-run" : "write"} for GameHub game ${result.gameId} (${plan.slug})`,
    `Status: ${result.status}`,
    `Matched IGDB game: ${matched}`,
    `Plan: ${[
      pluralized(plan.creates.length, "create"),
      pluralized(plan.updates.length, "update"),
      pluralized(plan.skips.length, "skip"),
      pluralized(plan.warnings.length, "warning"),
      pluralized(plan.conflicts.length, "conflict"),
    ].join(", ")}`,
    `Affected rows: ${result.affectedRows}`,
  ].join("\n");
}

function formatCliError(error: unknown, json: boolean): string {
  if (error instanceof IgdbError) {
    return json
      ? JSON.stringify({ error: error.toJSON() }, null, 2)
      : `IGDB enrichment failed (${error.code}): ${error.message}`;
  }

  const safeError = {
    name: "Error",
    code: "unexpected_error",
    message: "Unexpected IGDB enrichment failure",
  };
  return json
    ? JSON.stringify({ error: safeError }, null, 2)
    : `IGDB enrichment failed (${safeError.code}): ${safeError.message}`;
}

export async function runIgdbEnrichCli(
  args: IgdbEnrichCliArgs,
  dependencies: IgdbEnrichCliDependencies,
): Promise<number> {
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));
  let platform: IgdbEnrichmentPlatform | undefined;
  let operation: { ok: true; result: IgdbEnrichmentResult } | { ok: false; error: unknown };

  try {
    platform = await dependencies.platformFactory();
    const enricher = dependencies.enricherFactory(platform.env.DB);
    const result = await enricher.enrichGame(args.gameId, { dryRun: !args.write });
    operation = { ok: true, result };
  } catch (error) {
    operation = { ok: false, error };
  }

  let cleanupFailed = false;
  if (platform) {
    try {
      await platform.dispose();
    } catch {
      cleanupFailed = true;
    }
  }

  if (!operation.ok) {
    stderr(formatCliError(operation.error, args.json));
    return 1;
  }

  if (cleanupFailed) {
    stderr(formatCliError(undefined, args.json));
    return 1;
  }

  stdout(args.json
    ? JSON.stringify(operation.result, null, 2)
    : formatHumanResult(operation.result));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let args: IgdbEnrichCliArgs;
  try {
    args = parseIgdbEnrichArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid IGDB enrichment arguments");
    return 1;
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  const { getPlatformProxy } = await import("wrangler");

  return runIgdbEnrichCli(args, {
    platformFactory: () => createLocalIgdbEnrichmentPlatform(
      (options) => getPlatformProxy<{ DB: AnyD1Database }>(options),
    ),
    enricherFactory: (binding) => {
      const auth = createIgdbAuthClient({ clientId, clientSecret });
      const client = createIgdbClient({ auth, clientId: clientId ?? "" });
      const store = createIgdbEnrichmentStore(createDatabase(binding));
      return createIgdbEnricher({ client, store });
    },
  });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error("IGDB enrichment failed (unexpected_error): Unexpected IGDB enrichment failure");
      process.exitCode = 1;
    });
}
