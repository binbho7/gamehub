import { fileURLToPath, pathToFileURL } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { GetPlatformProxyOptions } from "wrangler";
import { createDatabase } from "../lib/db/client";
import { readImageMigrationPreflight } from "../lib/db/validation";

export type ImageMigrationPreflightResult = {
  legacyStorageUrlCount: number;
  duplicateIdentityCount: number;
};

export type ImageMigrationPreflightPlatform = {
  env: { DB: AnyD1Database };
  dispose(): Promise<void> | void;
};

export type ImageMigrationPlatformFactory = () => Promise<ImageMigrationPreflightPlatform>;

export function createLocalImageMigrationPlatform<Platform extends ImageMigrationPreflightPlatform>(
  getPlatformProxy: (options: GetPlatformProxyOptions) => Promise<Platform>,
): Promise<Platform> {
  return getPlatformProxy({
    configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
    persist: true,
    remoteBindings: false,
  });
}

async function createDefaultPlatform(): Promise<ImageMigrationPreflightPlatform> {
  const { getPlatformProxy } = await import("wrangler");
  return createLocalImageMigrationPlatform(getPlatformProxy);
}

/**
 * Read the target local D1 state before applying the image metadata migration.
 * This function has one responsibility: it reports the two hard-stop counts.
 * It deliberately does not apply migrations, clean rows, or deduplicate data.
 */
export async function runImageMigrationPreflight(
  platformFactory: ImageMigrationPlatformFactory = createDefaultPlatform,
): Promise<ImageMigrationPreflightResult> {
  const platform = await platformFactory();
  try {
    return await readImageMigrationPreflight(createDatabase(platform.env.DB));
  } finally {
    await platform.dispose();
  }
}

export type ImageMigrationPreflightOutput = {
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export async function runImageMigrationPreflightCli(
  platformFactory: ImageMigrationPlatformFactory = createDefaultPlatform,
  output: ImageMigrationPreflightOutput = {},
): Promise<number> {
  const stdout = output.stdout ?? ((message: string) => console.log(message));
  const stderr = output.stderr ?? ((message: string) => console.error(message));
  try {
    const result = await runImageMigrationPreflight(platformFactory);
    stdout(`legacyStorageUrlCount: ${result.legacyStorageUrlCount}`);
    stdout(`duplicateIdentityCount: ${result.duplicateIdentityCount}`);
    if (result.legacyStorageUrlCount !== 0 || result.duplicateIdentityCount !== 0) {
      stderr("Image migration preflight failed; stop before applying migration 4");
      return 1;
    }
    return 0;
  } catch {
    stderr("Image migration preflight failed; stop before applying migration 4");
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runImageMigrationPreflightCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
