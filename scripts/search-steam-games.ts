import { pathToFileURL } from "node:url";
import {
  createSteamSearchService,
  type SteamSearchService,
  type SteamSearchResponse,
} from "../lib/providers/steam/search/service";
import { SteamSearchError } from "../lib/providers/steam/search/errors";

export type SteamSearchCliArgs = {
  query: string;
  limit?: number;
  json: boolean;
};

export type SteamSearchCliDependencies = {
  searchService: Pick<SteamSearchService, "search">;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

export function parseSteamSearchArgs(argv: string[]): SteamSearchCliArgs {
  const queries: string[] = [];
  let limit: number | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--json") {
      if (json) {
        throw new Error("Duplicate --json option");
      }
      json = true;
      continue;
    }

    if (argument === "--limit") {
      if (limit !== undefined) {
        throw new Error("Duplicate --limit option");
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("Missing --limit value");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new Error("Invalid --limit value");
      }
      limit = parsed;
      index += 1;
      continue;
    }

    if (argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    }

    queries.push(argument);
  }

  if (queries.length !== 1) {
    throw new Error("Expected exactly one Steam search query");
  }

  return { query: queries[0], limit, json };
}

function formatHumanResults(response: SteamSearchResponse): string {
  const lines = response.results.length === 0
    ? [`No Steam games found for "${response.query}".`]
    : response.results.map((result, index) => (
      `${index + 1}. ${result.name} (App ID: ${result.appId})`
    ));

  if (response.warnings.length > 0) {
    lines.push(`Warnings: ${response.warnings.length}`);
  }

  return lines.join("\n");
}

function formatSteamSearchError(error: SteamSearchError): string {
  return JSON.stringify({
    error: {
      name: error.name,
      code: error.code,
      message: error.message,
    },
  }, null, 2);
}

export async function runSteamSearchCli(
  args: SteamSearchCliArgs,
  dependencies: SteamSearchCliDependencies,
): Promise<number> {
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));

  try {
    const response = await dependencies.searchService.search(args.query, { limit: args.limit });
    stdout(args.json ? JSON.stringify(response, null, 2) : formatHumanResults(response));
    return 0;
  } catch (error) {
    if (error instanceof SteamSearchError) {
      stderr(formatSteamSearchError(error));
      return 1;
    }
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  let args: SteamSearchCliArgs;
  try {
    args = parseSteamSearchArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }

  return runSteamSearchCli(args, { searchService: createSteamSearchService() });
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
