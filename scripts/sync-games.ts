import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertCompleteBatch, runBulkSyncBatch } from "../lib/sync/batch";
import { publicError, type FatalCode } from "../lib/sync/errors";
import { parseBulkSyncArgs, type BulkSyncArgs, type ReadUtf8 } from "../lib/sync/input";
import { formatBulkSyncResultHuman, formatBulkSyncResultJson } from "../lib/sync/presentation";
import type { BulkGameSyncResult } from "../lib/sync/types";
import {
  createLocalBulkSyncDependencies,
  validateBulkSyncConfig,
  type BulkSyncConfig,
  type BulkSyncDependencies,
} from "./sync-composition";

export type BulkSyncCliDependencies = {
  readFile: ReadUtf8;
  env: Readonly<Record<string, string | undefined>>;
  createDependencies(config: BulkSyncConfig): Promise<BulkSyncDependencies>;
  runBatch: typeof runBulkSyncBatch;
  formatHuman(result: BulkGameSyncResult): string;
  formatJson(result: BulkGameSyncResult): string;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
};

export async function runBulkSyncCli(
  argv: readonly string[],
  deps: BulkSyncCliDependencies,
): Promise<number> {
  let json = argv.includes("--json");
  const diagnostic = async (code: FatalCode): Promise<void> => {
    const error = publicError(code);
    try {
      await deps.stderr((json ? JSON.stringify(error) : `${error.code}: ${error.message}`) + "\n");
    } catch {
      // Diagnostics are best effort and are never retried.
    }
  };

  let args: BulkSyncArgs;
  let config: BulkSyncConfig;
  try {
    args = parseBulkSyncArgs(argv, deps.readFile);
    config = validateBulkSyncConfig(deps.env);
    json = args.json;
  } catch {
    await diagnostic("configuration_error");
    return 1;
  }

  let handle: BulkSyncDependencies;
  try {
    handle = await deps.createDependencies(config);
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      && error.code === "platform_unavailable" ? "platform_unavailable" : "composition_failed";
    await diagnostic(code);
    return 1;
  }

  let result: BulkGameSyncResult | undefined;
  try {
    const value = await deps.runBatch({ appIds: args.appIds, dryRun: !args.write, stages: handle.stages });
    assertCompleteBatch(value, args.appIds, !args.write);
    result = value;
  } catch {
    // Partial or invalid batches are never emitted.
  }

  let cleanupFailed = false;
  try {
    await handle.dispose();
  } catch {
    cleanupFailed = true;
  }

  if (!result) {
    await diagnostic("batch_execution_failed");
    return 1;
  }

  let formatted: string;
  try {
    formatted = json ? deps.formatJson(result) : deps.formatHuman(result);
  } catch {
    await diagnostic("output_format_failed");
    return 1;
  }

  try {
    await deps.stdout(formatted + "\n");
  } catch {
    await diagnostic("output_write_failed");
    return 1;
  }

  if (cleanupFailed) {
    await diagnostic("cleanup_failed");
    return 1;
  }
  return result.failed === 0 ? 0 : 1;
}

function writeStream(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      stream.write(text, (error?: Error | null) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

const defaultDependencies: BulkSyncCliDependencies = {
  readFile: (path, encoding) => readFileSync(path, encoding),
  env: process.env,
  createDependencies: createLocalBulkSyncDependencies,
  runBatch: runBulkSyncBatch,
  formatHuman: formatBulkSyncResultHuman,
  formatJson: formatBulkSyncResultJson,
  stdout: (text) => writeStream(process.stdout, text),
  stderr: (text) => writeStream(process.stderr, text),
};

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runBulkSyncCli(process.argv.slice(2), defaultDependencies).then(
    (code) => { process.exitCode = code; },
    async () => {
      try {
        await defaultDependencies.stderr(`${publicError("batch_execution_failed").code}: ${publicError("batch_execution_failed").message}\n`);
      } catch { /* best effort */ }
      process.exitCode = 1;
    },
  );
}
