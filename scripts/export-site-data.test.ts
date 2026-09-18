import { describe, expect, it } from "vitest";
import { parseExportArgs, runExport } from "./export-site-data";
import type { SiteSnapshot } from "../lib/site-data/read-model";

const snapshot: SiteSnapshot = { games: [] };

describe("local site data export CLI", () => {
  it.each([
    [[], "snapshot date is required"],
    [["--snapshot-date", "2026-09-19T00:00:00Z"], "snapshot date must be YYYY-MM-DD"],
    [["--snapshot-date", "2026-02-30"], "snapshot date is invalid"],
    [["--remote", "--snapshot-date", "2026-09-19"], "unsupported argument --remote"],
    [["--env", "--snapshot-date", "2026-09-19"], "unsupported argument --env"],
    [["--config", "wrangler.jsonc", "--snapshot-date", "2026-09-19"], "unsupported argument --config"],
    [["--snapshot-date", "2026-09-19", "--snapshot-date", "2026-09-20"], "snapshot date must be provided once"],
    [["--snapshot-date", "2026-09-19", "extra"], "unexpected positional argument"],
  ])("rejects unsafe arguments %j", (argv, message) => {
    expect(() => parseExportArgs(argv)).toThrow(message);
  });

  it("requires explicit valid snapshot date", () => {
    expect(parseExportArgs(["--snapshot-date", "2026-09-19"])).toEqual({ snapshotDate: "2026-09-19" });
  });

  it("fails closed without writing an artifact when no game is eligible", async () => {
    const writes: string[] = [];
    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19"], readSnapshot: async () => snapshot, writeFile: async (path) => { writes.push(path); } })).rejects.toThrow(/no eligible games/i);
    expect(writes).toEqual([]);
  });

  it("writes deterministic artifact and safe operator report for eligible output", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runExport({
      argv: ["--snapshot-date", "2026-09-19"],
      readSnapshot: async () => snapshot,
      writeFile: async (path, content) => { writes.push({ path, content }); },
      evaluate: () => [{
        published: {
          slug: "a", title: "A", description: "D", releaseDate: "2026-09-18", status: "released", developer: "D", publisher: "P", genres: ["Action"], platforms: ["PC"], cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg", screenshots: [], officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/" }], videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
        },
        diagnostics: [],
      }],
    });
    expect(result).toMatchObject({ eligibleCount: 1, excludedCount: 0 });
    expect(writes.map((item) => item.path)).toEqual(["generated/site-data.json", "generated/export-report.json"]);
    expect(writes[1]!.content).not.toMatch(/raw|secret|storage|local|providerPayload/i);
  });
});
