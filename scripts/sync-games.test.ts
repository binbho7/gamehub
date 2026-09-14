import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { publicError } from "../lib/sync/errors";
import { formatBulkSyncResultHuman, formatBulkSyncResultJson } from "../lib/sync/presentation";
import type { BulkGameSyncResult } from "../lib/sync/types";
import { runBulkSyncCli, writeTextToStream, type BulkSyncCliDependencies } from "./sync-games";
import { createLocalBulkSyncDependencies } from "./sync-composition";

const complete: BulkGameSyncResult = { dryRun: true, total: 1, succeeded: 1, failed: 0, games: [{
  appId: "10", gameId: null, status: "succeeded", stages: [
    { name: "steam", status: "succeeded", summary: "Steam created." },
    ...(["igdb", "links", "images"] as const).map((name) => ({ name, status: "not_run" as const,
      reason: "canonical_game_not_persisted" as const, summary: "Stage not run: canonical_game_not_persisted." })),
  ],
}] };

const failedComplete: BulkGameSyncResult = { dryRun: true, total: 1, succeeded: 0, failed: 1, games: [{
  appId: "10", gameId: null, status: "failed", stages: [
    { name: "steam", status: "failed", summary: "Steam failed.", error: { code: "network_error", message: "Bulk sync steam stage failed (network_error)." } },
    ...(["igdb", "links", "images"] as const).map((name) => ({ name, status: "not_run" as const,
      reason: "previous_stage_failed" as const, summary: "Stage not run: previous_stage_failed." })),
  ],
}] };

function dependencies(overrides: Partial<BulkSyncCliDependencies> = {}): BulkSyncCliDependencies {
  return {
    readFile: () => "", env: { TWITCH_CLIENT_ID: "id", TWITCH_CLIENT_SECRET: "secret", IMAGE_INGEST_TOKEN: "token" },
    createDependencies: async () => ({ stages: {} as never, dispose: vi.fn() }),
    runBatch: async () => complete, formatHuman: formatBulkSyncResultHuman, formatJson: formatBulkSyncResultJson,
    stdout: vi.fn(), stderr: vi.fn(), ...overrides,
  };
}

describe("bulk sync CLI lifecycle", () => {
  it("validation failure has zero acquisition", async () => {
    const createDependencies = vi.fn(); const stdout = vi.fn(); const stderr = vi.fn();
    expect(await runBulkSyncCli(["--json", "--bad"], dependencies({ createDependencies, stdout, stderr }))).toBe(1);
    expect(createDependencies).not.toHaveBeenCalled(); expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual(publicError("configuration_error"));
  });

  it("uses the Task 10 factory ownership for composition failure", async () => {
    const dispose = vi.fn().mockRejectedValue(new Error("cleanup secret")); const stderr = vi.fn();
    const createDependencies = (config: Parameters<typeof createLocalBulkSyncDependencies>[0]) =>
      createLocalBulkSyncDependencies(config, {
        acquire: async () => ({ env: { DB: {} as never }, dispose }),
        compose: () => { throw new Error("composition secret"); },
      });
    expect(await runBulkSyncCli(["10", "--json"], dependencies({ createDependencies, stderr }))).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(JSON.stringify(publicError("composition_failed")) + "\n");
  });

  it("emits a complete result only after disposal", async () => {
    const events: string[] = [];
    const deps = dependencies({
      createDependencies: async () => ({ stages: {} as never, dispose: async () => { events.push("dispose"); } }),
      runBatch: async () => { events.push("batch"); return complete; },
      formatHuman: () => { events.push("format"); return "human"; },
      stdout: () => { events.push("stdout"); },
    });
    expect(await runBulkSyncCli(["10"], deps)).toBe(0);
    expect(events).toEqual(["batch", "dispose", "format", "stdout"]);
  });

  it.each([false, true])("cleanup plus formatter failure emits only output_format_failed (json=%s)", async (json) => {
    const stdout = vi.fn(); const stderr = vi.fn(); const dispose = vi.fn().mockRejectedValue(new Error("cleanup secret"));
    const code = await runBulkSyncCli(["10", ...(json ? ["--json"] : [])], dependencies({
      createDependencies: async () => ({ stages: {} as never, dispose }),
      formatHuman: () => { throw new Error("formatter secret"); },
      formatJson: () => { throw new Error("formatter secret"); }, stdout, stderr,
    }));
    expect(code).toBe(1); expect(dispose).toHaveBeenCalledTimes(1); expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith((json
      ? JSON.stringify(publicError("output_format_failed"))
      : "output_format_failed: The bulk sync result could not be formatted.") + "\n");
  });

  it.each([
    ["configuration_error", ["--bad"], {}, 0],
    ["platform_unavailable", ["10"], { createDependencies: async () => { throw publicError("platform_unavailable"); } }, 0],
    ["batch_execution_failed", ["10"], { runBatch: async () => { throw new Error("batch secret"); } }, 1],
    ["output_format_failed", ["10"], { formatHuman: () => { throw new Error("format secret"); } }, 1],
    ["output_write_failed", ["10"], { stdout: async () => { throw new Error("sink secret"); } }, 1],
  ] as const)("maps lifecycle failure to %s", async (code, argv, overrides, disposeCount) => {
    const dispose = vi.fn(); const stderr = vi.fn();
    const deps = dependencies({ createDependencies: async () => ({ stages: {} as never, dispose }), ...overrides, stderr });
    expect(await runBulkSyncCli(argv, deps)).toBe(1);
    expect(dispose).toHaveBeenCalledTimes(disposeCount);
    expect(String(stderr.mock.calls[0]?.[0])).toContain(code);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("secret");
  });

  it("stdout and stderr failures cannot escape or retry", async () => {
    const stdout = vi.fn(async () => { throw new Error("sink secret"); });
    const stderr = vi.fn(async () => { throw new Error("diagnostic secret"); });
    expect(await runBulkSyncCli(["10"], dependencies({ stdout, stderr }))).toBe(1);
    expect(stdout).toHaveBeenCalledTimes(1); expect(stderr).toHaveBeenCalledTimes(1);
  });

  it("emits failed-game complete results with exit one", async () => {
    const stdout = vi.fn();
    expect(await runBulkSyncCli(["10", "--json"], dependencies({ runBatch: async () => failedComplete, formatJson: JSON.stringify, stdout }))).toBe(1);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(failedComplete);
  });

  it.each([false, true])("preserves a complete result when cleanup fails (json=%s)", async (json) => {
    const stdout = vi.fn(); const stderr = vi.fn(); const dispose = vi.fn().mockRejectedValue(new Error("cleanup secret"));
    const code = await runBulkSyncCli(["10", ...(json ? ["--json"] : [])], dependencies({
      createDependencies: async () => ({ stages: {} as never, dispose }), stdout, stderr,
    }));
    expect(code).toBe(1); expect(stdout).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("cleanup_failed");
    expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain("cleanup secret");
  });

  it("batch plus cleanup failure keeps the batch error and emits no result", async () => {
    const stdout = vi.fn(); const stderr = vi.fn(); const dispose = vi.fn().mockRejectedValue(new Error("cleanup secret"));
    expect(await runBulkSyncCli(["10", "--json"], dependencies({
      createDependencies: async () => ({ stages: {} as never, dispose }),
      runBatch: async () => { throw new Error("batch secret"); }, stdout, stderr,
    }))).toBe(1);
    expect(stdout).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(JSON.stringify(publicError("batch_execution_failed")) + "\n");
  });

  it("cleanup plus stdout failure selects the output error", async () => {
    const stderr = vi.fn(); const dispose = vi.fn().mockRejectedValue(new Error("cleanup secret"));
    const stdout = vi.fn(async () => { throw new Error("output secret"); });
    expect(await runBulkSyncCli(["10", "--json"], dependencies({
      createDependencies: async () => ({ stages: {} as never, dispose }), stdout, stderr,
    }))).toBe(1);
    expect(stdout).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(JSON.stringify(publicError("output_write_failed")) + "\n");
  });

  it("rejects an incomplete batch without formatting or stdout", async () => {
    const formatHuman = vi.fn(() => "should not run"); const stdout = vi.fn(); const stderr = vi.fn();
    expect(await runBulkSyncCli(["10"], dependencies({
      runBatch: async () => ({ ...complete, total: 0 }), formatHuman, stdout, stderr,
    }))).toBe(1);
    expect(formatHuman).not.toHaveBeenCalled(); expect(stdout).not.toHaveBeenCalled();
    expect(String(stderr.mock.calls[0]?.[0])).toContain("batch_execution_failed");
  });

  it.each([
    ["sync", () => { throw new Error("sink secret"); }],
    ["async", async () => { throw new Error("sink secret"); }],
  ] as const)("handles %s stdout failure with one diagnostic attempt", async (_kind, failingSink) => {
    const stdout = vi.fn(failingSink); const stderr = vi.fn();
    expect(await runBulkSyncCli(["10"], dependencies({ stdout, stderr }))).toBe(1);
    expect(stdout).toHaveBeenCalledTimes(1); expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("sink secret");
  });

  it("JSON output is one complete sanitized document with no fatal envelope", async () => {
    const unsafe: BulkGameSyncResult = structuredClone(complete);
    unsafe.games[0]!.stages[0]!.summary = "https://user:pass@example.test/a?token=value#fragment";
    const stdout = vi.fn();
    expect(await runBulkSyncCli(["10", "--json"], dependencies({
      runBatch: async () => unsafe,
      stdout,
    }))).toBe(0);
    const output = String(stdout.mock.calls[0]?.[0]);
    expect(JSON.parse(output).total).toBe(1); expect(output).not.toContain('"error":{"code":"cleanup_failed"');
    expect(output).not.toContain("value");
  });

  it.each([false, true])("failed-game result survives cleanup failure (json=%s)", async (json) => {
    const stdout = vi.fn(); const stderr = vi.fn(); const dispose = vi.fn().mockRejectedValue(new Error("cleanup secret"));
    expect(await runBulkSyncCli(["10", ...(json ? ["--json"] : [])], dependencies({
      createDependencies: async () => ({ stages: {} as never, dispose }),
      runBatch: async () => failedComplete, stdout, stderr,
    }))).toBe(1);
    expect(stdout).toHaveBeenCalledTimes(1); expect(dispose).toHaveBeenCalledTimes(1);
    const diagnostic = String(stderr.mock.calls[0]?.[0]);
    if (json) expect(JSON.parse(diagnostic)).toEqual(publicError("cleanup_failed"));
    else expect(diagnostic).toBe("cleanup_failed: The local bulk sync platform could not be disposed.\n");
  });

  it.each([false, true])("fatal diagnostics use the selected output mode (json=%s)", async (json) => {
    const stderr = vi.fn();
    expect(await runBulkSyncCli([...(json ? ["--json"] : []), "--bad"], dependencies({ stderr }))).toBe(1);
    const diagnostic = String(stderr.mock.calls[0]?.[0]);
    if (json) expect(JSON.parse(diagnostic)).toEqual(publicError("configuration_error"));
    else expect(diagnostic).toBe("configuration_error: Bulk sync input or configuration is invalid.\n");
  });

  it.each([
    ["sync", () => { throw new Error("stderr secret"); }],
    ["async", async () => { throw new Error("stderr secret"); }],
  ] as const)("fatal error preserves exit when stderr fails %s", async (_kind, stderrFailure) => {
    const createDependencies = vi.fn(async () => { throw publicError("platform_unavailable"); });
    const stderr = vi.fn(stderrFailure); const stdout = vi.fn();
    expect(await runBulkSyncCli(["10", "--json"], dependencies({ createDependencies, stderr, stdout }))).toBe(1);
    expect(createDependencies).toHaveBeenCalledTimes(1); expect(stderr).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("bulk sync stream sink", () => {
  it("rejects a real Writable EPIPE without an unhandled error and removes its listener", async () => {
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    const stream = new Writable({ write(_chunk, _encoding, callback) { callback(error); } });
    await expect(writeTextToStream(stream, "result\n")).rejects.toBe(error);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stream.listenerCount("error")).toBe(0);
  });
});

describe("bulk sync operator surface", () => {
  it("exposes the exact package script and documented CLI examples", () => {
    const root = new URL("../", import.meta.url);
    const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const readme = readFileSync(new URL("README.md", root), "utf8");
    expect(packageJson.scripts["games:sync"]).toBe("tsx scripts/sync-games.ts");
    for (const command of [
      "npx wrangler dev --config workers/image-ingest/wrangler.jsonc --local --persist-to .wrangler/state --port 8787",
      "npm run games:sync -- 1245620 1091500 292030",
      "npm run games:sync -- --file games.txt --json",
      "npm run games:sync -- --file games.txt --write",
    ]) expect(readme).toContain(command);
    expect(readme).toContain("same repository `.wrangler/state/v3` and local `gamehub` D1 identity");
    expect(readme).toContain("There is no remote bulk target.");
  });
});
