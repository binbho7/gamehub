import { describe, expect, it } from "vitest";
import { parseExportArgs, runExport } from "./export-site-data";
import type { SiteSnapshot } from "../lib/site-data/read-model";

const snapshot: SiteSnapshot = { games: [] };

const publishedGame = (slug: string) => ({
  slug, title: slug, description: "D", releaseDate: "2026-09-18", status: "released" as const,
  developer: "D", publisher: "P", genres: ["Action"], genreSlugs: ["action"], platforms: ["Windows"], platformSlugs: ["windows"],
  cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg",
  screenshots: [], officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/" }], videos: [],
  optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
});

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
    expect(writes).toEqual(["generated/export-report.json"]);
  });

  it("writes deterministic artifact and safe operator report for eligible output", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runExport({
      argv: ["--snapshot-date", "2026-09-19"],
      readSnapshot: async () => snapshot,
      writeFile: async (path, content) => { writes.push({ path, content }); },
      evaluate: () => [{
        published: {
          slug: "a", title: "A", description: "D", releaseDate: "2026-09-18", status: "released", developer: "D", publisher: "P", genres: ["Action"], genreSlugs: ["action"], platforms: ["PC"], platformSlugs: ["pc"], cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg", screenshots: [], officialLinks: [{ provider: "website", type: "official_website", url: "https://example.com/" }], videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
        },
        diagnostics: [],
      }],
    });
    expect(result).toMatchObject({ eligibleCount: 1, excludedCount: 0 });
    expect(writes.map((item) => item.path)).toEqual(["generated/export-report.json", "generated/site-data.json"]);
    expect(writes[0]!.content).not.toMatch(/raw|secret|storage|local|providerPayload/i);
  });

  it("normalizes publication order before validating and serializing", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const game = (slug: string) => ({
      slug, title: slug, description: "D", releaseDate: "2026-09-18", status: "released" as const,
      developer: "D", publisher: "P", genres: ["Z", "A"], genreSlugs: ["z", "a"], platforms: ["Windows", "Steam"], platformSlugs: ["windows", "steam"],
      cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg",
      screenshots: ["https://images.igdb.com/z.jpg", "https://cdn.akamai.steamstatic.com/a.jpg"],
      officialLinks: [
        { provider: "z", type: "official_website", url: "https://z.example/" },
        { provider: "a", type: "official_website", url: "https://a.example/" },
      ], videos: [{ provider: "youtube" as const, id: "z".repeat(11), title: null }],
      optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
    });
    const evaluate = () => [{ published: game("z"), diagnostics: [] }, { published: game("a"), diagnostics: [] }];
    await runExport({ argv: ["--snapshot-date", "2026-09-19"], readSnapshot: async () => snapshot, evaluate, writeFile: async (path, content) => { writes.push({ path, content }); } });
    const artifact = JSON.parse(writes[1]!.content) as { games: Array<{ slug: string; genres: string[]; officialLinks: Array<{ provider: string }> }> };
    expect(artifact.games.map((item) => item.slug)).toEqual(["a", "z"]);
    expect(artifact.games[0]!.genres).toEqual(["A", "Z"]);
    expect(artifact.games[0]!.officialLinks.map((link) => link.provider)).toEqual(["a", "z"]);
  });

  it("fails closed and does not partially overwrite when any snapshot row is ineligible", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    await expect(runExport({
      argv: ["--snapshot-date", "2026-09-19"],
      readSnapshot: async () => snapshot,
      evaluate: () => [
        { published: publishedGame("valid"), diagnostics: [] },
        { published: null, diagnostics: [{ slug: "invalid", code: "missing_title", message: "title is missing" }] },
      ],
      writeFile: async (path, content) => { writes.push({ path, content }); },
    })).rejects.toThrow(/ineligible/i);
    expect(writes.map(({ path }) => path)).toEqual(["generated/export-report.json"]);
    expect(JSON.parse(writes[0]!.content)).toEqual({ totalGames: 2, eligibleCount: 1, excludedCount: 1, exclusions: [{ slug: "invalid", code: "missing_title" }] });
  });

  it("writes byte-identical diagnostics for repeated failed snapshots", async () => {
    const reports: string[] = [];
    const options = { argv: ["--snapshot-date", "2026-09-19"], readSnapshot: async () => snapshot, evaluate: () => [{ published: null, diagnostics: [{ slug: "z", code: "bad", message: "bad" }] }], writeFile: async (path: string, content: string) => { if (path.endsWith("export-report.json")) reports.push(content); } };
    await expect(runExport(options)).rejects.toThrow();
    await expect(runExport(options)).rejects.toThrow();
    expect(reports).toHaveLength(2);
    expect(reports[0]).toBe(reports[1]);
  });

  it("fails closed for duplicate slugs even when every row has a published projection", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    await expect(runExport({
      argv: ["--snapshot-date", "2026-09-19"],
      readSnapshot: async () => snapshot,
      evaluate: () => [
        { published: publishedGame("same"), diagnostics: [{ slug: "same", code: "duplicate_slug", message: "duplicate" }] },
        { published: publishedGame("same"), diagnostics: [{ slug: "same", code: "duplicate_slug", message: "duplicate" }] },
      ],
      writeFile: async (path, content) => { writes.push({ path, content }); },
    })).rejects.toThrow(/ineligible/i);
    expect(writes.map(({ path }) => path)).toEqual(["generated/export-report.json"]);
  });
});
