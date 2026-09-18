import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runBulkSyncBatch } from "../../lib/sync/batch";
import { formatBulkSyncResultHuman, formatBulkSyncResultJson } from "../../lib/sync/presentation";
import { stageError, type BulkSyncStages } from "../../lib/sync/stages";
import type { BulkGameSyncResult } from "../../lib/sync/types";
import { runBulkSyncCli, type BulkSyncCliDependencies } from "../../scripts/sync-games";

const BASELINE = "122a78085b7ba8b2a01521dfc9cbcfc5ada1ec9a";
const ROOT = new URL("../../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

function cliDependencies(createDependencies: BulkSyncCliDependencies["createDependencies"]): BulkSyncCliDependencies {
  return {
    readFile: () => "--remote\n",
    env: {
      TWITCH_CLIENT_ID: "fixture-client",
      TWITCH_CLIENT_SECRET: "fixture-secret",
      IMAGE_INGEST_TOKEN: "fixture-token",
    },
    createDependencies,
    runBatch: async () => { throw new Error("must not run"); },
    formatHuman: formatBulkSyncResultHuman,
    formatJson: formatBulkSyncResultJson,
    stdout: vi.fn(),
    stderr: vi.fn(),
  };
}

describe("V2.7 bulk sync security invariants", () => {
  it("preserves V2.6 schema migrations and dependency graph", () => {
    const schema = read("lib/db/schema.ts");
    expect(createHash("sha1").update(schema).digest("hex"))
      .toBe("f0133d569a777f72b9a74af48059cf61b7d946c0");
    expect(readdirSync(new URL("drizzle", ROOT)).filter((name) => name.endsWith(".sql")))
      .toHaveLength(5);

    const before = JSON.parse(execFileSync(
      "git",
      ["show", `${BASELINE}:package.json`],
      { cwd: new URL(".", ROOT), encoding: "utf8" },
    ));
    const after = JSON.parse(read("package.json"));
    expect(after.dependencies).toEqual(before.dependencies);
    expect(after.devDependencies).toEqual(before.devDependencies);
    expect(read("package-lock.json")).toBe(execFileSync(
      "git",
      ["show", `${BASELINE}:package-lock.json`],
      { cwd: new URL(".", ROOT), encoding: "utf8", maxBuffer: 10_000_000 },
    ));
  });

  it("pure bulk runtime has no environment network or child-process globals", () => {
    const directory = new URL("lib/sync/", ROOT);
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(new URL(file, directory), "utf8");
      expect(source, file).not.toMatch(/from\s+["']node:/);
      expect(source, file).not.toMatch(/from\s+["'](?:wrangler|node:child_process|child_process)["']/);
      expect(source, file).not.toMatch(/\b(?:process|console)\s*\./);
      expect(source, file).not.toMatch(/(?<![.\w])fetch\s*\(/);
      expect(source, file).not.toMatch(/\b(?:exec|execFile|spawn|fork)\s*\(/);
      expect(source, file).not.toMatch(/Promise\.all\s*\(/);
    }
  });

  it("remote and file-injected flags never acquire platform", async () => {
    const cases = [
      ["--remote"],
      ["--config", "alternate.jsonc"],
      ["--database-id", "remote-id"],
      ["--env", "preview"],
      ["-e", "preview"],
      ["--file", "games.txt", "--write"],
    ];

    for (const argv of cases) {
      const createDependencies = vi.fn();
      const deps = cliDependencies(createDependencies);
      expect(await runBulkSyncCli(argv, deps), argv.join(" ")).toBe(1);
      expect(createDependencies, argv.join(" ")).not.toHaveBeenCalled();
      expect(deps.stdout, argv.join(" ")).not.toHaveBeenCalled();
      expect(deps.stderr, argv.join(" ")).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(deps.stderr).mock.calls[0]?.[0])).toContain("configuration_error");
    }
  });

  it("public output omits provider payload tokens Authorization and unknown keys", () => {
    const secret = "v27-do-not-print";
    const raw = {
      dryRun: false,
      total: 1,
      succeeded: 0,
      failed: 1,
      games: [{
        appId: "10",
        gameId: 10,
        status: "failed",
        stages: [{
          name: "steam",
          status: "failed",
          summary: `Provider URL https://user:pass@example.test/path?access_token=${secret}#fragment`,
          error: stageError("steam", "network_error"),
          providerPayload: { access_token: secret, Authorization: `Bearer ${secret}` },
        }, {
          name: "igdb", status: "not_run", reason: "previous_stage_failed",
          summary: "Stage not run: previous_stage_failed.",
        }, {
          name: "links", status: "not_run", reason: "previous_stage_failed",
          summary: "Stage not run: previous_stage_failed.",
        }, {
          name: "images", status: "not_run", reason: "previous_stage_failed",
          summary: "Stage not run: previous_stage_failed.",
        }],
        nativeError: { token: secret, Authorization: `Bearer ${secret}` },
      }],
      unknownRoot: { credential: secret },
    } as unknown as BulkGameSyncResult;

    for (const output of [formatBulkSyncResultJson(raw), formatBulkSyncResultHuman(raw)]) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain("user:pass");
      expect(output).not.toContain("#fragment");
      expect(output).not.toContain("Authorization");
      expect(output).not.toContain("providerPayload");
      expect(output).not.toContain("nativeError");
      expect(output).not.toContain("unknownRoot");
      expect(output).toContain("[REDACTED]");
    }
  });

  it("keeps the V2.7 bulk runner free of job-platform flags", async () => {
    const calls = new Map<string, number>();
    const success = async (appId: string) => {
      calls.set(appId, (calls.get(appId) ?? 0) + 1);
      if (appId === "10") throw stageError("steam", "network_error");
      return { gameId: Number(appId), action: "existing" as const, summary: "Steam existing." };
    };
    const canonical = { execute: async () => ({ summary: "succeeded" }) };
    const stages: BulkSyncStages = {
      steam: { execute: success },
      igdb: canonical,
      links: canonical,
      images: canonical,
    };
    const result = await runBulkSyncBatch({ appIds: ["10", "20"], dryRun: false, stages });
    expect([...calls]).toEqual([["10", 1], ["20", 1]]);
    expect(result).toMatchObject({ total: 2, succeeded: 1, failed: 1 });

    for (const flag of ["--resume", "--retry", "--remote"]) {
      const createDependencies = vi.fn();
      expect(await runBulkSyncCli(["10", flag], cliDependencies(createDependencies)))
        .toBe(1);
      expect(createDependencies).not.toHaveBeenCalled();
    }
  });
});
