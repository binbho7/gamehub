import { pathToFileURL } from "node:url";
import { presentImageResult, formatImageResultHuman } from "../lib/images/presentation";
import type { ImageResult } from "../lib/images/types";

export type CliOptions = {
  gameId: number;
  write: boolean;
  json: boolean;
  workerUrl: string;
  token: string;
};

export const DEFAULT_IMAGE_INGEST_WORKER_URL =
  "http://127.0.0.1:8787/internal/images/ingest";
const WORKER_URL_ENV = "IMAGE_INGEST_WORKER_URL";
const TOKEN_ENV = "IMAGE_INGEST_TOKEN";
const IMAGE_INGEST_PATH = "/internal/images/ingest";

function cliError(message: string): Error {
  return new Error(message);
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function resolveWorkerUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IMAGE_INGEST_WORKER_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw cliError("Invalid image ingest Worker endpoint");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cliError("Image ingest Worker endpoint must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw cliError("Image ingest Worker endpoint cannot contain credentials, query, or fragment");
  }
  if (!isLocalHostname(url.hostname) && url.protocol !== "https:") {
    throw cliError("Non-local image ingest Worker endpoint must use HTTPS");
  }
  if (url.pathname !== "/" && url.pathname !== IMAGE_INGEST_PATH) {
    throw cliError("Image ingest Worker endpoint must target the image ingest route");
  }
  url.pathname = IMAGE_INGEST_PATH;
  return url.href;
}

function resolveToken(env: NodeJS.ProcessEnv): string {
  const token = env[TOKEN_ENV];
  if (token === undefined || token.length === 0 || token.trim() !== token || /\s/.test(token)) {
    throw cliError("IMAGE_INGEST_TOKEN is required");
  }
  return token;
}

export function parseImageIngestArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const ids: string[] = [];
  let write = false;
  let json = false;

  for (const argument of argv) {
    if (argument === "--write") {
      if (write) throw cliError("Duplicate --write option");
      write = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw cliError("Duplicate --json option");
      json = true;
      continue;
    }
    if (argument.startsWith("-")) throw cliError("Unknown option");
    ids.push(argument);
  }

  if (ids.length !== 1 || !/^\d+$/.test(ids[0] ?? "")) {
    throw cliError("Expected exactly one positive integer GameHub game ID");
  }
  const gameId = Number(ids[0]);
  if (!Number.isSafeInteger(gameId) || gameId <= 0) {
    throw cliError("Expected exactly one positive integer GameHub game ID");
  }

  return {
    gameId,
    write,
    json,
    workerUrl: resolveWorkerUrl(env[WORKER_URL_ENV]),
    token: resolveToken(env),
  };
}

function outputResult(result: ImageResult, json: boolean): void {
  const presented = presentImageResult(result);
  console.log(json ? JSON.stringify(presented, null, 2) : formatImageResultHuman(presented));
}

/**
 * Call the configured Worker only. The CLI intentionally has no D1/R2
 * bindings and never downloads an image source itself.
 */
export async function runImageIngestCli(
  options: CliOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(options.workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({ gameId: options.gameId, write: options.write }),
    });
  } catch {
    throw cliError("Image ingest Worker request failed");
  }

  if (!response.ok) {
    throw cliError(`Image ingest Worker request failed (HTTP ${response.status})`);
  }

  let result: ImageResult;
  try {
    result = await response.json() as ImageResult;
  } catch {
    throw cliError("Image ingest Worker returned an invalid response");
  }
  outputResult(result, options.json);
}

function printEntrypointError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : "Image ingest failed";
  const safeMessage = message.includes("IMAGE_INGEST_TOKEN") || message.includes("endpoint") ||
    message.includes("option") || message.includes("ID")
    ? message
    : "Image ingest failed";
  console.error(json
    ? JSON.stringify({ error: { code: "cli_error", message: safeMessage } }, null, 2)
    : `Image ingest failed: ${safeMessage}`);
}

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  try {
    const options = parseImageIngestArgs(argv, process.env);
    await runImageIngestCli(options);
    return 0;
  } catch (error) {
    printEntrypointError(error, json);
    return 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
