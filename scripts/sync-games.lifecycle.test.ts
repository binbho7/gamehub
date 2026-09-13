import { describe, expect, it, vi } from "vitest";
import { runBulkSyncBatch } from "../lib/sync/batch";
import { formatBulkSyncResultHuman, formatBulkSyncResultJson } from "../lib/sync/presentation";
import type { BulkSyncStages } from "../lib/sync/stages";
import type { BulkGameSyncResult } from "../lib/sync/types";
import { createLocalBulkSyncDependencies } from "./sync-composition";
import { runBulkSyncCli, type BulkSyncCliDependencies } from "./sync-games";

const SECRET = "lifecycle-secret-must-not-escape";
const failure = () => new Error(`provider payload ${SECRET}`, {
  cause: { authorization: `Bearer ${SECRET}`, stack: SECRET },
});

const complete: BulkGameSyncResult = {
  dryRun: true, total: 1, succeeded: 1, failed: 0,
  games: [{
    appId: "10", gameId: null, status: "succeeded", stages: [
      { name: "steam", status: "succeeded", summary: "Steam created." },
      { name: "igdb", status: "not_run", reason: "canonical_game_not_persisted", summary: "Stage not run: canonical_game_not_persisted." },
      { name: "links", status: "not_run", reason: "canonical_game_not_persisted", summary: "Stage not run: canonical_game_not_persisted." },
      { name: "images", status: "not_run", reason: "canonical_game_not_persisted", summary: "Stage not run: canonical_game_not_persisted." },
    ],
  }],
};
const failedComplete: BulkGameSyncResult = {
  dryRun: true, total: 1, succeeded: 0, failed: 1,
  games: [{
    appId: "10", gameId: null, status: "failed", stages: [
      { name: "steam", status: "failed", summary: "Steam failed.",
        error: { code: "network_error", message: "Bulk sync steam stage failed (network_error)." } },
      { name: "igdb", status: "not_run", reason: "previous_stage_failed", summary: "Stage not run: previous_stage_failed." },
      { name: "links", status: "not_run", reason: "previous_stage_failed", summary: "Stage not run: previous_stage_failed." },
      { name: "images", status: "not_run", reason: "previous_stage_failed", summary: "Stage not run: previous_stage_failed." },
    ],
  }],
};
const humanComplete = [
  "Bulk sync dry-run: total=1 succeeded=1 failed=0",
  "App 10 game=none succeeded",
  "  steam succeeded Steam created.",
  "  igdb not_run Stage not run: canonical_game_not_persisted. reason=canonical_game_not_persisted",
  "  links not_run Stage not run: canonical_game_not_persisted. reason=canonical_game_not_persisted",
  "  images not_run Stage not run: canonical_game_not_persisted. reason=canonical_game_not_persisted",
  "Failed App IDs: none", "",
].join("\n");
const humanFailed = [
  "Bulk sync dry-run: total=1 succeeded=0 failed=1",
  "App 10 game=none failed",
  "  steam failed Steam failed. network_error: Bulk sync steam stage failed (network_error).",
  "  igdb not_run Stage not run: previous_stage_failed. reason=previous_stage_failed",
  "  links not_run Stage not run: previous_stage_failed. reason=previous_stage_failed",
  "  images not_run Stage not run: previous_stage_failed. reason=previous_stage_failed",
  "Failed App IDs: 10", "",
].join("\n");

const diagnostics = {
  configuration_error: "Bulk sync input or configuration is invalid.",
  platform_unavailable: "The local bulk sync platform could not be acquired.",
  composition_failed: "Bulk sync stage dependencies could not be created.",
  batch_execution_failed: "Bulk sync could not produce a complete batch result.",
  cleanup_failed: "The local bulk sync platform could not be disposed.",
  output_format_failed: "The bulk sync result could not be formatted.",
  output_write_failed: "The bulk sync result could not be written.",
} as const;
type Diagnostic = keyof typeof diagnostics;
type SinkMode = "success" | "sync" | "async";

function expectedDiagnostic(json: boolean, code: Diagnostic): string {
  const message = diagnostics[code];
  return (json ? JSON.stringify({ code, message }) : `${code}: ${message}`) + "\n";
}

function lifecycle(options: {
  result?: BulkGameSyncResult;
  cleanupFails?: boolean;
  stdout?: SinkMode;
  stderr?: SinkMode;
} = {}) {
  const events: string[] = [];
  const sink = (name: "stdout" | "stderr", mode: SinkMode = "success") => vi.fn<(text: string) => void | Promise<void>>(() => {
    events.push(name);
    if (mode === "sync") throw failure();
    if (mode === "async") return Promise.reject(failure());
  });
  const stdout = sink("stdout", options.stdout);
  const stderr = sink("stderr", options.stderr);
  const dispose = vi.fn(async () => {
    events.push("dispose");
    if (options.cleanupFails) throw failure();
  });
  const runBatch = vi.fn<BulkSyncCliDependencies["runBatch"]>(async () => {
    events.push("batch");
    return options.result ?? complete;
  });
  const formatHuman = vi.fn((result: BulkGameSyncResult) => {
    events.push("human");
    return formatBulkSyncResultHuman(result);
  });
  const formatJson = vi.fn((result: BulkGameSyncResult) => {
    events.push("json");
    return formatBulkSyncResultJson(result);
  });
  const createDependencies = vi.fn<BulkSyncCliDependencies["createDependencies"]>(async () => {
    events.push("acquire");
    return { stages: {} as BulkSyncStages, dispose };
  });
  const deps: BulkSyncCliDependencies = {
    readFile: () => "10\n", env: {
      TWITCH_CLIENT_ID: "id", TWITCH_CLIENT_SECRET: SECRET, IMAGE_INGEST_TOKEN: "token",
    }, createDependencies, runBatch, formatHuman, formatJson, stdout, stderr,
  };
  return { deps, events, stdout, stderr, dispose, runBatch, formatHuman, formatJson, createDependencies };
}

function assertNoLeak(harness: ReturnType<typeof lifecycle>) {
  const publicText = JSON.stringify([harness.stdout.mock.calls, harness.stderr.mock.calls]);
  for (const forbidden of [SECRET, "provider payload", '"cause"', '"stack"', "Bearer ", "authorization"]) {
    expect(publicText).not.toContain(forbidden);
  }
}

function assertResult(harness: ReturnType<typeof lifecycle>, json: boolean, failed: boolean) {
  const result = failed ? failedComplete : complete;
  expect(harness.stdout).toHaveBeenCalledTimes(1);
  if (json) {
    const output = harness.stdout.mock.calls[0]![0];
    expect(output.endsWith("\n")).toBe(true);
    const emitted = JSON.parse(output);
    expect(emitted).toEqual(result);
    expect(emitted.total).toBe(emitted.games.length);
    expect(emitted.succeeded + emitted.failed).toBe(emitted.total);
    expect(Object.keys(emitted).sort()).toEqual(["dryRun", "failed", "games", "succeeded", "total"]);
  } else {
    expect(harness.stdout).toHaveBeenCalledExactlyOnceWith(failed ? humanFailed : humanComplete);
  }
  expect(json ? harness.formatJson : harness.formatHuman).toHaveBeenCalledExactlyOnceWith(result);
  expect(json ? harness.formatHuman : harness.formatJson).not.toHaveBeenCalled();
  assertNoLeak(harness);
}

describe.each([false, true])("approved lifecycle/output matrix (json=%s)", (json) => {
  const argv = ["10", ...(json ? ["--json"] : [])];
  const formatEvent = json ? "json" : "human";

  it.each(["argv", "file", "config", "endpoint"] as const)("%s validation has no acquired lifecycle", async (kind) => {
    const h = lifecycle();
    let input = argv;
    if (kind === "argv") input = ["--bad", ...argv];
    if (kind === "file") {
      input = ["--file", "games.txt", ...argv];
      h.deps.readFile = () => { throw failure(); };
    }
    if (kind === "config") h.deps.env = {};
    if (kind === "endpoint") h.deps.env = { ...h.deps.env, IMAGE_INGEST_WORKER_URL: "https://remote.example/" };
    expect(await runBulkSyncCli(input, h.deps)).toBe(1);
    expect(h.createDependencies).not.toHaveBeenCalled();
    expect(h.runBatch).not.toHaveBeenCalled();
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.formatHuman).not.toHaveBeenCalled();
    expect(h.formatJson).not.toHaveBeenCalled();
    expect(h.stdout).not.toHaveBeenCalled();
    expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "configuration_error"));
    assertNoLeak(h);
  });

  it.each(["success", "sync", "async"] as const)("acquisition failure retains no handle when diagnostic sink is %s", async (stderr) => {
    const h = lifecycle({ stderr });
    h.deps.createDependencies = (config) => createLocalBulkSyncDependencies(config, {
      acquire: async () => { h.events.push("acquire"); throw failure(); },
      compose: () => { throw new Error("must not compose"); },
    });
    expect(await runBulkSyncCli(argv, h.deps)).toBe(1);
    expect(h.events).toEqual(["acquire", "stderr"]);
    expect(h.runBatch).not.toHaveBeenCalled();
    expect(h.dispose).not.toHaveBeenCalled();
    expect(h.stdout).not.toHaveBeenCalled();
    expect(h.formatHuman).not.toHaveBeenCalled();
    expect(h.formatJson).not.toHaveBeenCalled();
    expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "platform_unavailable"));
    assertNoLeak(h);
  });

  it.each([false, true])("composition rejection remains factory-owned (cleanupFails=%s)", async (cleanupFails) => {
    const h = lifecycle({ cleanupFails });
    h.deps.createDependencies = (config) => createLocalBulkSyncDependencies(config, {
      acquire: async () => { h.events.push("acquire"); return { env: { DB: {} as never }, dispose: h.dispose }; },
      compose: () => { h.events.push("compose"); throw failure(); },
    });
    expect(await runBulkSyncCli(argv, h.deps)).toBe(1);
    expect(h.events).toEqual(["acquire", "compose", "dispose", "stderr"]);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.runBatch).not.toHaveBeenCalled();
    expect(h.stdout).not.toHaveBeenCalled();
    expect(h.formatHuman).not.toHaveBeenCalled();
    expect(h.formatJson).not.toHaveBeenCalled();
    expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "composition_failed"));
    assertNoLeak(h);
  });

  it.each([false, true])("batch throw suppresses an actually completed first game (cleanupFails=%s)", async (cleanupFails) => {
    const h = lifecycle({ cleanupFails });
    let first: BulkGameSyncResult | undefined;
    const stages: BulkSyncStages = {
      steam: { execute: async () => ({ action: "create", gameId: null, summary: "Steam created." }) },
      igdb: { execute: async () => { throw new Error("must not run"); } },
      links: { execute: async () => { throw new Error("must not run"); } },
      images: { execute: async () => { throw new Error("must not run"); } },
    };
    h.runBatch.mockImplementation(async (input) => {
      first = await runBulkSyncBatch({ ...input, appIds: [input.appIds[0]!], stages });
      h.events.push("first-game-completed");
      throw Object.assign(failure(), { partialResult: first });
    });
    expect(await runBulkSyncCli(["10", "20", ...(json ? ["--json"] : [])], h.deps)).toBe(1);
    expect(first).toEqual(complete);
    expect(h.events).toEqual(["acquire", "first-game-completed", "dispose", "stderr"]);
    expect(h.runBatch).toHaveBeenCalledTimes(1);
    expect(h.runBatch.mock.calls[0]![0].appIds).toEqual(["10", "20"]);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.stdout).not.toHaveBeenCalled();
    expect(h.formatHuman).not.toHaveBeenCalled();
    expect(h.formatJson).not.toHaveBeenCalled();
    expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "batch_execution_failed"));
    assertNoLeak(h);
  });

  it.each([false, true])("batch throw before the first game emits no result (cleanupFails=%s)", async (cleanupFails) => {
    const h = lifecycle({ cleanupFails });
    h.runBatch.mockImplementation(async () => { h.events.push("batch"); throw failure(); });
    expect(await runBulkSyncCli(argv, h.deps)).toBe(1);
    expect(h.events).toEqual(["acquire", "batch", "dispose", "stderr"]);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(h.runBatch).toHaveBeenCalledTimes(1);
    expect(h.stdout).not.toHaveBeenCalled();
    expect(h.formatHuman).not.toHaveBeenCalled();
    expect(h.formatJson).not.toHaveBeenCalled();
    expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "batch_execution_failed"));
    assertNoLeak(h);
  });

  for (const failed of [false, true]) {
    it.each([false, true])(`complete result (failedGames=${failed}) survives cleanup outcome %s`, async (cleanupFails) => {
      const h = lifecycle({ result: failed ? failedComplete : complete, cleanupFails });
      expect(await runBulkSyncCli(argv, h.deps)).toBe(failed || cleanupFails ? 1 : 0);
      expect(h.dispose).toHaveBeenCalledTimes(1);
      expect(h.events).toEqual(["acquire", "batch", "dispose", formatEvent, "stdout", ...(cleanupFails ? ["stderr"] : [])]);
      assertResult(h, json, failed);
      if (cleanupFails) expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "cleanup_failed"));
      else expect(h.stderr).not.toHaveBeenCalled();
    });

    it.each(["sync", "async"] as const)(`complete result (failedGames=${failed}) survives cleanup and %s stderr failure`, async (stderr) => {
      const h = lifecycle({ result: failed ? failedComplete : complete, cleanupFails: true, stderr });
      expect(await runBulkSyncCli(argv, h.deps)).toBe(1);
      expect(h.dispose).toHaveBeenCalledTimes(1);
      expect(h.events).toEqual(["acquire", "batch", "dispose", formatEvent, "stdout", "stderr"]);
      assertResult(h, json, failed);
      expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "cleanup_failed"));
    });
  }

  it.each([false, true])("formatter failure takes precedence over cleanup (cleanupFails=%s)", async (cleanupFails) => {
    const h = lifecycle({ cleanupFails });
    (json ? h.formatJson : h.formatHuman).mockImplementation(() => { h.events.push(formatEvent); throw failure(); });
    expect(await runBulkSyncCli(argv, h.deps)).toBe(1);
    expect(h.events).toEqual(["acquire", "batch", "dispose", formatEvent, "stderr"]);
    expect(h.dispose).toHaveBeenCalledTimes(1);
    expect(json ? h.formatJson : h.formatHuman).toHaveBeenCalledExactlyOnceWith(complete);
    expect(json ? h.formatHuman : h.formatJson).not.toHaveBeenCalled();
    expect(h.stdout).not.toHaveBeenCalled();
    expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "output_format_failed"));
    assertNoLeak(h);
  });

  for (const cleanupFails of [false, true]) {
    for (const stdout of ["sync", "async"] as const) {
      it.each(["success", "sync", "async"] as const)(`stdout ${stdout} rejection has one output diagnostic (cleanupFails=${cleanupFails}, stderr=%s)`, async (stderr) => {
        const h = lifecycle({ cleanupFails, stdout, stderr });
        expect(await runBulkSyncCli(argv, h.deps)).toBe(1);
        expect(h.dispose).toHaveBeenCalledTimes(1);
        expect(h.events).toEqual(["acquire", "batch", "dispose", formatEvent, "stdout", "stderr"]);
        // The sink may have accepted a prefix; assert one complete attempted
        // write with no retry or appended diagnostic/raw-error fallback.
        assertResult(h, json, false);
        expect(h.stderr).toHaveBeenCalledExactlyOnceWith(expectedDiagnostic(json, "output_write_failed"));
      });
    }
  }
});
