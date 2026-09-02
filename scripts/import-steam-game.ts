import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { GetPlatformProxyOptions } from "wrangler";
import { createDatabase } from "../lib/db/client";
import { createSteamImportStore } from "../lib/db/repositories/steam-import";
import { SteamImportError } from "../lib/importers/errors";
import { createSteamImporter } from "../lib/importers/steam";
import { normalizeSteamAppId } from "../lib/providers/steam/app-id";
import { createSteamClient } from "../lib/providers/steam/client";
import { SteamProviderError } from "../lib/providers/steam/errors";

export type SteamImportCliArgs = {
  appId: string;
  write: boolean;
};

type SteamImporter = ReturnType<typeof createSteamImporter>;

export type SteamImportCliDependencies = {
  importer: Pick<SteamImporter, "importGame">;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseSteamImportArgs(argv: string[]): SteamImportCliArgs {
  const appIds: string[] = [];
  let write = false;

  for (const argument of argv) {
    if (argument === "--write") {
      if (write) {
        throw new Error("Duplicate --write option");
      }
      write = true;
      continue;
    }

    if (argument === "--remote" || argument.startsWith("--remote=")) {
      throw new Error("Remote bindings are not supported: --remote");
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }

    appIds.push(argument);
  }

  if (appIds.length !== 1) {
    throw new Error("Expected exactly one Steam App ID");
  }

  return { appId: normalizeSteamAppId(appIds[0]), write };
}

function formatTypedError(error: SteamProviderError | SteamImportError): string {
  return JSON.stringify({
    error: {
      name: error.name,
      code: error.code,
      message: error.message,
    },
  }, null, 2);
}

export function createLocalSteamImportPlatform<Platform>(
  getPlatformProxy: (options: GetPlatformProxyOptions) => Promise<Platform>,
): Promise<Platform> {
  return getPlatformProxy({
    configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    persist: true,
    remoteBindings: false,
  });
}

export async function runSteamImportCli(
  args: SteamImportCliArgs,
  dependencies?: SteamImportCliDependencies,
): Promise<number> {
  if (!dependencies) {
    throw new TypeError("Steam import CLI dependencies are required");
  }

  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));

  try {
    const result = await dependencies.importer.importGame(args.appId, { dryRun: !args.write });
    stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    if (error instanceof SteamProviderError || error instanceof SteamImportError) {
      stderr(formatTypedError(error));
      return 1;
    }
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  let args: SteamImportCliArgs;
  try {
    args = parseSteamImportArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }

  const { getPlatformProxy } = await import("wrangler");
  const platform = await createLocalSteamImportPlatform(
    (options) => getPlatformProxy<{ DB: AnyD1Database }>(options),
  );

  try {
    const importer = createSteamImporter({
      client: createSteamClient(),
      store: createSteamImportStore(createDatabase(platform.env.DB)),
    });
    return await runSteamImportCli(args, { importer });
  } finally {
    await platform.dispose();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
