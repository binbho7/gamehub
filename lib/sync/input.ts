import { normalizeSteamAppId } from "../providers/steam/app-id";
import { publicError } from "./errors";

export const MAX_BATCH_SIZE = 100;

export type ReadUtf8 = (path: string, encoding: "utf8") => string;

export type BulkSyncArgs = {
  appIds: string[];
  write: boolean;
  json: boolean;
};

export function normalizeBulkSyncAppIds(values: readonly string[]): string[] {
  try {
    const appIds = [...new Set(values.map((value) => normalizeSteamAppId(value)))];
    if (appIds.length < 1 || appIds.length > MAX_BATCH_SIZE) throw null;
    return appIds;
  } catch {
    throw publicError("configuration_error");
  }
}

export function parseBulkSyncArgs(argv: readonly string[], readFile: ReadUtf8): BulkSyncArgs {
  const values: string[] = [];
  const seen = new Set<string>();
  let write = false;
  let json = false;

  try {
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i]!;
      if (token === "--write" || token === "--json" || token === "--file") {
        if (seen.has(token)) throw null;
        seen.add(token);
        if (token === "--write") write = true;
        else if (token === "--json") json = true;
        else {
          const path = argv[++i];
          if (!path || path.startsWith("-")) throw null;
          values.push(...readFile(path, "utf8").split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith("#")));
        }
      } else {
        if (token.startsWith("-")) throw null;
        values.push(token);
      }
    }
    return { appIds: normalizeBulkSyncAppIds(values), write, json };
  } catch {
    throw publicError("configuration_error");
  }
}
