import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import validFixture from "../test/fixtures/steam/appdetails-valid.json";
import type { SteamImportStore } from "../lib/db/repositories/steam-import";
import type { SteamImportResult } from "../lib/importers/candidate";
import { SteamImportError } from "../lib/importers/errors";
import { createSteamImporter } from "../lib/importers/steam";
import type { SteamClient } from "../lib/providers/steam/client";
import { SteamProviderError } from "../lib/providers/steam/errors";
import {
  createLocalSteamImportPlatform,
  parseSteamImportArgs,
  runSteamImportCli,
} from "./import-steam-game";

it("documents the local Steam import command", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  expect(readme).toContain("steam:import");
  expect(readme).toContain("--write");
  expect(readme).toContain("dry-run");
  expect(readme).toContain("local D1");
});

const dryRunResult: SteamImportResult = {
  status: "created",
  gameId: null,
  appId: "1245620",
  dryRun: true,
  plan: {
    action: "create",
    selectedSlug: "elden-ring",
    existingGameId: null,
    candidate: {
      source: {
        provider: "steam",
        externalId: "1245620",
        fetchedAt: new Date("2026-09-02T01:02:03.000Z"),
      },
      game: {
        preferredSlug: "elden-ring",
        title: "Elden Ring",
        summary: "The new fantasy action RPG.",
        description: null,
        status: "released",
        releaseDate: "2022-02-25",
        coverUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/capsule_616x353.jpg",
        heroUrl: "https://cdn.akamai.steamstatic.com/steam/apps/1245620/header.jpg",
      },
      externalIds: [{
        provider: "steam",
        externalId: "1245620",
        externalUrl: "https://store.steampowered.com/app/1245620/",
      }],
      officialLinks: [{
        provider: "steam",
        platform: null,
        linkType: "store",
        url: "https://store.steampowered.com/app/1245620/",
        isOfficial: true,
        verificationStatus: "verified",
        verificationMethod: "provider_api",
      }],
      genres: [],
      platforms: [],
      companies: [],
      images: [],
      videos: [],
    },
    resolvedCompanies: [],
    creates: [{ entity: "game", key: "elden-ring" }],
    updates: [],
    skips: [],
    warnings: [],
  },
};

describe("parseSteamImportArgs", () => {
  it("defaults a single App ID to dry-run mode", () => {
    expect(parseSteamImportArgs(["1245620"])).toEqual({ appId: "1245620", write: false });
  });

  it("enables writes only for one explicit --write option", () => {
    expect(parseSteamImportArgs(["1245620", "--write"])).toEqual({ appId: "1245620", write: true });
  });

  it("rejects --remote explicitly", () => {
    expect(() => parseSteamImportArgs(["1245620", "--remote"])).toThrow(/--remote/);
  });

  it.each(["--unknown", "--env", "--config", "--database-id", "--url"])(
    "rejects unsupported option %s",
    (option) => {
      expect(() => parseSteamImportArgs(["1245620", option])).toThrow(/unknown/i);
    },
  );

  it.each([
    { name: "zero App IDs", argv: [] },
    { name: "an option-only invocation", argv: ["--write"] },
    { name: "multiple App IDs", argv: ["1245620", "570"] },
  ])("rejects $name", ({ argv }) => {
    expect(() => parseSteamImportArgs(argv)).toThrow(/exactly one Steam App ID/i);
  });

  it("rejects duplicate --write options", () => {
    expect(() => parseSteamImportArgs(["1245620", "--write", "--write"])).toThrow(/duplicate.*--write/i);
  });

  it.each([
    "https://remote.example.test/import",
    "wrangler.remote.jsonc",
    "123e4567-e89b-12d3-a456-426614174000",
  ])("rejects non-App-ID positional input %s", (input) => {
    expect(() => parseSteamImportArgs([input])).toThrowError(
      expect.objectContaining({ code: "invalid_app_id" }),
    );
  });
});

describe("runSteamImportCli", () => {
  it.each([
    { write: false, dryRun: true },
    { write: true, dryRun: false },
  ])("passes dryRun=$dryRun when write=$write", async ({ write, dryRun }) => {
    const importer = { importGame: vi.fn().mockResolvedValue({ ...dryRunResult, dryRun }) };
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runSteamImportCli(
      { appId: "1245620", write },
      { importer, stdout, stderr },
    );

    expect(exitCode).toBe(0);
    expect(importer.importGame).toHaveBeenCalledOnce();
    expect(importer.importGame).toHaveBeenCalledWith("1245620", { dryRun });
    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ ...dryRunResult, dryRun }, null, 2));
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    new SteamProviderError("rate_limited", "Steam rate limited", { retryable: true, status: 429 }),
    new SteamImportError("write_conflict", "Steam import conflicted"),
  ])("returns exit code 1 for typed $name errors", async (error) => {
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runSteamImportCli(
      { appId: "1245620", write: false },
      { importer: { importGame: vi.fn().mockRejectedValue(error) }, stdout, stderr },
    );

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(error.code));
  });

  it("rethrows unexpected programming errors", async () => {
    const cause = new Error("unexpected failure");

    await expect(runSteamImportCli(
      { appId: "1245620", write: false },
      { importer: { importGame: vi.fn().mockRejectedValue(cause) }, stdout: vi.fn(), stderr: vi.fn() },
    )).rejects.toBe(cause);
  });

  it("runs the real importer in dry-run mode without calling the injected store write boundary", async () => {
    const applyPlan = vi.fn<SteamImportStore["applyPlan"]>();
    const store: SteamImportStore = {
      findSnapshotByExternalId: vi.fn().mockResolvedValue(null),
      findGameBySlug: vi.fn().mockResolvedValue(null),
      findGenresBySlugs: vi.fn().mockResolvedValue([]),
      findPlatformsBySlugs: vi.fn().mockResolvedValue([]),
      findCompaniesBySlugs: vi.fn().mockResolvedValue([]),
      applyPlan,
    };
    const client: SteamClient = {
      fetchAppDetails: vi.fn().mockResolvedValue({
        body: validFixture,
        fetchedAt: new Date("2026-09-02T01:02:03.000Z"),
        requestUrl: "https://store.steampowered.com/api/appdetails?appids=1245620",
      }),
    };
    const stdout = vi.fn();

    const exitCode = await runSteamImportCli(
      { appId: "1245620", write: false },
      { importer: createSteamImporter({ client, store }), stdout, stderr: vi.fn() },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      appId: "1245620",
      dryRun: true,
      plan: { action: "create" },
    });
    expect(applyPlan).not.toHaveBeenCalled();
  });
});

describe("local Wrangler platform construction", () => {
  it("uses only the fixed repository config and local persistent bindings", async () => {
    const platform = { env: { DB: {} }, dispose: vi.fn() };
    const getPlatformProxy = vi.fn().mockResolvedValue(platform);

    const created = await createLocalSteamImportPlatform(getPlatformProxy);

    expect(created).toBe(platform);
    expect(getPlatformProxy).toHaveBeenCalledOnce();
    expect(getPlatformProxy).toHaveBeenCalledWith({
      configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
      persist: true,
      remoteBindings: false,
    });
  });
});
