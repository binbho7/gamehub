import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SteamSearchResponse } from "../lib/providers/steam/search/service";
import { SteamSearchError } from "../lib/providers/steam/search/errors";
import {
  parseSteamSearchArgs,
  runSteamSearchCli,
} from "./search-steam-games";

const searchResponse: SteamSearchResponse = {
  query: "elden ring",
  results: [
    { appId: "1245620", name: "ELDEN RING", type: "game", imageUrl: "https://cdn.example.test/elden.jpg" },
    { appId: "570", name: "Dota 2", type: "game", imageUrl: null },
  ],
  warnings: [
    { code: "invalid_image_url", message: "Ignored unsafe image URL", itemIndex: 4 },
    { code: "result_limit_applied", message: "Limited results to 2" },
  ],
};

describe("parseSteamSearchArgs", () => {
  it("accepts one query with read-only defaults", () => {
    expect(parseSteamSearchArgs(["elden ring"])).toEqual({
      query: "elden ring",
      limit: undefined,
      json: false,
    });
  });

  it("accepts an explicit limit and JSON output", () => {
    expect(parseSteamSearchArgs(["elden ring", "--limit", "5", "--json"])).toEqual({
      query: "elden ring",
      limit: 5,
      json: true,
    });
  });

  it.each([
    { name: "no query", argv: [] },
    { name: "two queries", argv: ["elden ring", "dark souls"] },
  ])("rejects $name", ({ argv }) => {
    expect(() => parseSteamSearchArgs(argv)).toThrow(/exactly one Steam search query/i);
  });

  it.each([
    { name: "a missing value", argv: ["elden ring", "--limit"] },
    { name: "a flag in place of its value", argv: ["elden ring", "--limit", "--json"] },
    { name: "a non-numeric value", argv: ["elden ring", "--limit", "five"] },
    { name: "a duplicate option", argv: ["elden ring", "--limit", "5", "--limit", "10"] },
  ])("rejects --limit with $name", ({ argv }) => {
    expect(() => parseSteamSearchArgs(argv)).toThrow(/limit/i);
  });

  it("rejects duplicate JSON output options", () => {
    expect(() => parseSteamSearchArgs(["elden ring", "--json", "--json"])).toThrow(/duplicate.*--json/i);
  });

  it.each([
    "--unknown",
    "--write",
    "--write=true",
    "--remote",
    "--remote=true",
    "--env",
    "--env=production",
    "--config",
    "--config=wrangler.jsonc",
    "--database-id",
    "--url=https://remote.example.test",
  ])("rejects unsupported option %s", (option) => {
    expect(() => parseSteamSearchArgs(["elden ring", option])).toThrow(/option|remote/i);
  });
});

describe("runSteamSearchCli", () => {
  it("prints numbered human-readable results and a concise warning summary", async () => {
    const search = vi.fn().mockResolvedValue(searchResponse);
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runSteamSearchCli(
      { query: "elden ring", limit: 2, json: false },
      { searchService: { search }, stdout, stderr },
    );

    expect(exitCode).toBe(0);
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith("elden ring", { limit: 2 });
    expect(stdout).toHaveBeenCalledWith([
      "1. ELDEN RING (App ID: 1245620)",
      "2. Dota 2 (App ID: 570)",
      "Warnings: 2",
    ].join("\n"));
    expect(stderr).not.toHaveBeenCalled();
  });

  it("prints a successful no-results message", async () => {
    const stdout = vi.fn();

    const exitCode = await runSteamSearchCli(
      { query: "not a game", json: false },
      { searchService: { search: vi.fn().mockResolvedValue({ query: "not a game", results: [], warnings: [] }) }, stdout },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith('No Steam games found for "not a game".');
  });

  it("keeps empty-result warnings to a concise summary", async () => {
    const stdout = vi.fn();

    const exitCode = await runSteamSearchCli(
      { query: "not a game", json: false },
      {
        searchService: {
          search: vi.fn().mockResolvedValue({
            query: "not a game",
            results: [],
            warnings: [{ code: "result_limit_applied", message: "Limited results to 2" }],
          }),
        },
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith([
      'No Steam games found for "not a game".',
      "Warnings: 1",
    ].join("\n"));
  });

  it("serializes the complete response as JSON", async () => {
    const stdout = vi.fn();

    const exitCode = await runSteamSearchCli(
      { query: "elden ring", json: true },
      { searchService: { search: vi.fn().mockResolvedValue(searchResponse) }, stdout },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(searchResponse, null, 2));
  });

  it("reports typed search errors to stderr and returns exit code 1", async () => {
    const error = new SteamSearchError("rate_limited", "Steam search rate limited", {
      retryable: true,
      status: 429,
    });
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runSteamSearchCli(
      { query: "elden ring", json: false },
      { searchService: { search: vi.fn().mockRejectedValue(error) }, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(JSON.stringify({
      error: { name: "SteamSearchError", code: "rate_limited", message: "Steam search rate limited" },
    }, null, 2));
  });

  it("rethrows unexpected errors", async () => {
    const error = new Error("unexpected failure");

    await expect(runSteamSearchCli(
      { query: "elden ring", json: false },
      { searchService: { search: vi.fn().mockRejectedValue(error) } },
    )).rejects.toBe(error);
  });
});

describe("Steam search CLI boundaries", () => {
  it("has no importer or database initialization path", () => {
    const source = readFileSync(new URL("./search-steam-games.ts", import.meta.url), "utf8");

    for (const reference of [
      "wrangler",
      "lib/db",
      "lib/importers",
      "createDatabase",
      "createSteamImporter",
      "createSteamImportStore",
    ]) {
      expect(source).not.toMatch(new RegExp(reference.replace("/", String.raw`\\/`), "i"));
    }
  });
});
