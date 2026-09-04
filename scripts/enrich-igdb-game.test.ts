import type { AnyD1Database } from "drizzle-orm/d1";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { IgdbEnrichmentResult } from "../lib/enrichers/igdb-candidate";
import { IgdbError } from "../lib/providers/igdb/errors";

vi.mock("../lib/importers/steam", () => {
  throw new Error("The IGDB CLI imported the Steam import service");
});

vi.mock("../lib/providers/steam/search/service", () => {
  throw new Error("The IGDB CLI imported the Steam search service");
});

import {
  createLocalIgdbEnrichmentPlatform,
  parseIgdbEnrichArgs,
  runIgdbEnrichCli,
} from "./enrich-igdb-game";

const dryRunResult: IgdbEnrichmentResult = {
  status: "enrich",
  gameId: 42,
  dryRun: true,
  affectedRows: 0,
  plan: {
    action: "enrich",
    gameId: 42,
    slug: "elden-ring",
    matchedIgdbGame: { id: "119133", name: "Elden Ring" },
    creates: [{
      entity: "external_id",
      key: "igdb:119133",
      values: {
        gameId: 42,
        provider: "igdb",
        externalId: "119133",
        externalUrl: null,
      },
    }],
    updates: [{
      entity: "game",
      key: "elden-ring",
      changes: { summary: "An action RPG." },
    }],
    skips: [{
      field: "game.title",
      reason: "Canonical title is authoritative",
      incoming: "ELDEN RING",
      stored: "Elden Ring",
    }],
    warnings: [{ code: "invalid_optional_item", message: "Ignored one optional website" }],
    conflicts: [],
  },
};

describe("parseIgdbEnrichArgs", () => {
  it("defaults one canonical game ID to dry-run human output", () => {
    expect(parseIgdbEnrichArgs(["42"])).toEqual({
      gameId: 42,
      write: false,
      json: false,
    });
  });

  it("accepts each local execution option once in either order", () => {
    expect(parseIgdbEnrichArgs(["--json", "42", "--write"])).toEqual({
      gameId: 42,
      write: true,
      json: true,
    });
  });

  it.each([
    ["duplicate --write", ["42", "--write", "--write"]],
    ["duplicate --json", ["42", "--json", "--json"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseIgdbEnrichArgs(argv)).toThrow(/duplicate/i);
  });

  it.each([
    ["missing ID", []],
    ["flags without an ID", ["--write", "--json"]],
    ["multiple IDs", ["42", "43"]],
  ])("rejects %s", (_name, argv) => {
    expect(() => parseIgdbEnrichArgs(argv)).toThrow(/exactly one.*game.*id/i);
  });

  it.each([
    "0",
    "-1",
    "1.5",
    "not-a-game-id",
    "9007199254740992",
  ])("rejects invalid canonical game ID %s", (gameId) => {
    expect(() => parseIgdbEnrichArgs([gameId])).toThrowError(
      expect.objectContaining({ code: "invalid_game_id" }),
    );
  });

  it.each([
    "--remote",
    "--remote=",
    "--remote=true",
    "--env",
    "--env=production",
    "-e",
    "--config",
    "--config=wrangler.remote.jsonc",
    "--database-id",
    "--database-id=123e4567-e89b-12d3-a456-426614174000",
    "--url",
    "--url=https://remote.example.test",
  ])("explicitly rejects non-local option %s", (option) => {
    expect(() => parseIgdbEnrichArgs(["42", option])).toThrow(/local|supported|option/i);
  });

  it.each([
    "--unknown",
    "--write=true",
    "--json=true",
    "-x",
  ])("rejects unknown flag %s", (option) => {
    expect(() => parseIgdbEnrichArgs(["42", option])).toThrow(/unknown option/i);
  });

  it("rejects an unknown URL-shaped flag without reflecting its token", () => {
    const token = "fake-parser-token-do-not-print";
    const option = `--base-url=https://remote.example.test/v4?access_token=${token}`;
    const error = (() => {
      try {
        parseIgdbEnrichArgs(["42", option]);
      } catch (caught) {
        return caught;
      }
      throw new Error("Expected parsing to fail");
    })();

    expect(String(error)).toMatch(/unknown option/i);
    expect(String(error)).not.toContain(option);
    expect(String(error)).not.toContain(token);
  });

  it.each([
    "123e4567-e89b-12d3-a456-426614174000",
    "https://remote.example.test/d1?token=fake-token-do-not-print",
    "file:///tmp/wrangler.remote.jsonc",
    "wrangler.remote.jsonc",
  ])("rejects database/configuration positional input without echoing it: %s", (input) => {
    const error = (() => {
      try {
        parseIgdbEnrichArgs([input]);
      } catch (caught) {
        return caught;
      }
      throw new Error("Expected parsing to fail");
    })();

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(input);
  });
});

describe("local Wrangler platform construction", () => {
  it("uses only the fixed repository config and persistent local bindings", async () => {
    const platform = { env: { DB: {} }, dispose: vi.fn() };
    const getPlatformProxy = vi.fn().mockResolvedValue(platform);

    const created = await createLocalIgdbEnrichmentPlatform(getPlatformProxy);

    expect(created).toBe(platform);
    expect(getPlatformProxy).toHaveBeenCalledOnce();
    expect(getPlatformProxy).toHaveBeenCalledWith({
      configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      persist: true,
      remoteBindings: false,
    });
  });
});

describe("runIgdbEnrichCli", () => {
  it.each([
    { write: false, dryRun: true },
    { write: true, dryRun: false },
  ])("initializes and disposes local D1 with dryRun=$dryRun when write=$write", async ({ write, dryRun }) => {
    const database = { kind: "local-d1" } as unknown as AnyD1Database;
    const dispose = vi.fn().mockResolvedValue(undefined);
    const platformFactory = vi.fn().mockResolvedValue({ env: { DB: database }, dispose });
    const result = { ...dryRunResult, dryRun } as IgdbEnrichmentResult;
    const enrichGame = vi.fn().mockResolvedValue(result);
    const enricherFactory = vi.fn().mockReturnValue({ enrichGame });
    const stdout = vi.fn();
    const stderr = vi.fn();

    const exitCode = await runIgdbEnrichCli(
      { gameId: 42, write, json: true },
      { platformFactory, enricherFactory, stdout, stderr },
    );

    expect(exitCode).toBe(0);
    expect(platformFactory).toHaveBeenCalledOnce();
    expect(enricherFactory).toHaveBeenCalledOnce();
    expect(enricherFactory).toHaveBeenCalledWith(database);
    expect(enrichGame).toHaveBeenCalledOnce();
    expect(enrichGame).toHaveBeenCalledWith(42, { dryRun });
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    expect(stderr).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("prints a concise human summary of the matched identity and plan sections", async () => {
    const stdout = vi.fn();

    const exitCode = await runIgdbEnrichCli(
      { gameId: 42, write: false, json: false },
      dependenciesFor(dryRunResult, { stdout }),
    );

    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith([
      "IGDB enrichment dry-run for GameHub game 42 (elden-ring)",
      "Status: enrich",
      "Matched IGDB game: Elden Ring (119133)",
      "Plan: 1 create, 1 update, 1 skip, 1 warning, 0 conflicts",
      "Affected rows: 0",
    ].join("\n"));
  });

  it.each([
    { json: false, expected: "IGDB enrichment failed (network_error): IGDB request failed" },
    {
      json: true,
      expected: JSON.stringify({
        error: {
          name: "IgdbError",
          code: "network_error",
          message: "IGDB request failed",
          retryable: true,
        },
      }, null, 2),
    },
  ])("prints a sanitized typed error when json=$json and still disposes local D1", async ({ json, expected }) => {
    const secret = "fake-twitch-secret-do-not-print";
    const token = "fake-access-token-do-not-print";
    const rawRequest = `https://id.twitch.test/token?client_secret=${secret}`;
    const error = new IgdbError("network_error", "IGDB request failed", {
      retryable: true,
      cause: {
        token,
        request: { url: rawRequest, headers: { Authorization: `Bearer ${token}` } },
      },
    });
    const stderr = vi.fn();
    const dependencies = dependenciesFor(Promise.reject(error), { stderr });

    const exitCode = await runIgdbEnrichCli(
      { gameId: 42, write: false, json },
      dependencies,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expected);
    const output = stderr.mock.calls.flat().join("\n");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
    expect(output).not.toContain(rawRequest);
    expect(dependencies.platform.dispose).toHaveBeenCalledOnce();
  });

  it.each([false, true])("does not expose unexpected errors when json=%s", async (json) => {
    const secret = "fake-unexpected-secret-do-not-print";
    const token = "fake-unexpected-token-do-not-print";
    const rawRequest = `https://api.igdb.test/v4/games?access_token=${token}`;
    const stderr = vi.fn();
    const dependencies = dependenciesFor(Promise.reject(Object.assign(
      new Error(`${secret} ${rawRequest}`),
      { headers: { Authorization: `Bearer ${token}` } },
    )), { stderr });

    const exitCode = await runIgdbEnrichCli(
      { gameId: 42, write: false, json },
      dependencies,
    );

    expect(exitCode).toBe(1);
    const output = stderr.mock.calls.flat().join("\n");
    expect(output).toContain("unexpected_error");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
    expect(output).not.toContain(rawRequest);
    expect(dependencies.platform.dispose).toHaveBeenCalledOnce();
  });
});

function dependenciesFor(
  outcome: IgdbEnrichmentResult | Promise<never>,
  output: {
    stdout?: (message: string) => void;
    stderr?: (message: string) => void;
  } = {},
) {
  const database = {} as AnyD1Database;
  const platform = {
    env: { DB: database },
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const enrichGame = outcome instanceof Promise
    ? vi.fn().mockReturnValue(outcome)
    : vi.fn().mockResolvedValue(outcome);

  return {
    platform,
    platformFactory: vi.fn().mockResolvedValue(platform),
    enricherFactory: vi.fn().mockReturnValue({ enrichGame }),
    stdout: output.stdout ?? vi.fn<(message: string) => void>(),
    stderr: output.stderr ?? vi.fn<(message: string) => void>(),
  };
}
