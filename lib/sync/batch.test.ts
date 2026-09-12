import { expect, it, vi } from "vitest";
import { assertCompleteBatch, runBulkSyncBatch } from "./batch";
import { publicError } from "./errors";
import { stageError, type BulkSyncStages } from "./stages";
import type { BulkGameResult, BulkGameSyncResult } from "./types";

function successfulStages(events: string[] = []): BulkSyncStages {
  return {
    steam: {
      execute: async (appId) => {
        events.push(`${appId} steam`);
        return { gameId: Number(appId), action: "existing", summary: "Steam existing." };
      },
    },
    igdb: {
      execute: async (gameId) => {
        events.push(`${gameId} igdb`);
        return { summary: "IGDB existing." };
      },
    },
    links: {
      execute: async (gameId) => {
        events.push(`${gameId} links`);
        return { summary: "Links no_changes; checked=0." };
      },
    },
    images: {
      execute: async (gameId) => {
        events.push(`${gameId} images`);
        return { summary: "Images completed." };
      },
    },
  };
}

function successfulGame(appId = "10"): BulkGameResult {
  return {
    appId,
    gameId: Number(appId),
    status: "succeeded",
    stages: [
      { name: "steam", status: "succeeded", summary: "Steam existing." },
      { name: "igdb", status: "succeeded", summary: "IGDB existing." },
      { name: "links", status: "succeeded", summary: "Links no_changes; checked=0." },
      { name: "images", status: "succeeded", summary: "Images completed." },
    ],
  };
}

function completeResult(games: BulkGameResult[], dryRun = true): BulkGameSyncResult {
  const failed = games.filter((game) => game.status === "failed").length;
  return {
    dryRun,
    total: games.length,
    succeeded: games.length - failed,
    failed,
    games,
  };
}

function expectBatchFailure(action: () => unknown) {
  try {
    action();
    throw new Error("expected batch execution failure");
  } catch (error) {
    expect(error).toEqual(publicError("batch_execution_failed"));
  }
}

it("runs A complete pipeline before B and continues after game failure", async () => {
  const events: string[] = [];
  const stages = successfulStages(events);
  stages.links = {
    execute: async (gameId) => {
      events.push(`${gameId} links`);
      if (gameId === 20) throw stageError("links", "timeout");
      return { summary: "Links no_changes; checked=0." };
    },
  };

  const result = await runBulkSyncBatch({
    appIds: ["10", "20", "30"],
    dryRun: true,
    stages,
  });

  expect(events).toEqual([
    "10 steam", "10 igdb", "10 links", "10 images",
    "20 steam", "20 igdb", "20 links",
    "30 steam", "30 igdb", "30 links", "30 images",
  ]);
  expect(result).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
  expect(result.games.map(({ appId, status }) => [appId, status])).toEqual([
    ["10", "succeeded"],
    ["20", "failed"],
    ["30", "succeeded"],
  ]);
});

it("awaits an unresolved game before starting the next game", async () => {
  let releaseFirstImage!: () => void;
  let markFirstImageStarted!: () => void;
  const firstImagePending = new Promise<void>((resolve) => {
    releaseFirstImage = resolve;
  });
  const firstImageStarted = new Promise<void>((resolve) => {
    markFirstImageStarted = resolve;
  });
  let secondSteamCalls = 0;
  const stages = successfulStages();
  stages.steam = {
    execute: async (appId) => {
      if (appId === "20") secondSteamCalls += 1;
      return { gameId: Number(appId), action: "existing", summary: "Steam existing." };
    },
  };
  stages.images = {
    execute: async (gameId) => {
      if (gameId === 10) {
        markFirstImageStarted();
        await firstImagePending;
      }
      return { summary: "Images completed." };
    },
  };

  const running = runBulkSyncBatch({ appIds: ["10", "20"], dryRun: false, stages });
  await firstImageStarted;
  expect(secondSteamCalls).toBe(0);
  releaseFirstImage();
  await expect(running).resolves.toMatchObject({ total: 2, succeeded: 2, failed: 0 });
  expect(secondSteamCalls).toBe(1);
});

it("validates the whole batch before making any stage call", async () => {
  const execute = vi.fn();
  const stages: BulkSyncStages = {
    steam: { execute },
    igdb: { execute },
    links: { execute },
    images: { execute },
  };

  await expect(runBulkSyncBatch({ appIds: ["10", "bad"], dryRun: true, stages }))
    .rejects.toEqual(publicError("configuration_error"));
  expect(execute).not.toHaveBeenCalled();
});

it("normalizes, deduplicates first-wins input, and returns exact counts in order", async () => {
  const result = await runBulkSyncBatch({
    appIds: ["010", "10"],
    dryRun: true,
    stages: successfulStages(),
  });

  expect(result).toEqual(completeResult([successfulGame("10")]));
});

it("does not retry a failed game or prevent the next game from running", async () => {
  const steamCalls = new Map<string, number>();
  const stages = successfulStages();
  stages.steam = {
    execute: async (appId) => {
      steamCalls.set(appId, (steamCalls.get(appId) ?? 0) + 1);
      if (appId === "10") throw stageError("steam", "network_error");
      return { gameId: Number(appId), action: "existing", summary: "Steam existing." };
    },
  };

  const result = await runBulkSyncBatch({
    appIds: ["10", "20"],
    dryRun: false,
    stages,
  });

  expect([...steamCalls]).toEqual([["10", 1], ["20", 1]]);
  expect(result).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
});

it("rejects incomplete totals and normalized input mismatches", () => {
  const result = completeResult([successfulGame("10")]);

  expectBatchFailure(() => assertCompleteBatch({ ...result, total: 2 }, ["10"], true));
  expectBatchFailure(() => assertCompleteBatch(result, ["20"], true));
  expectBatchFailure(() => assertCompleteBatch(result, ["010", "10"], false));
});

it("rejects malformed stage sequences, skip reasons, errors, and game status", () => {
  const valid = successfulGame();
  const malformed = [
    { ...valid, stages: valid.stages.slice(0, 3) },
    {
      ...valid,
      stages: valid.stages.map((stage, index) => index === 1
        ? { ...stage, name: "links" as const }
        : stage),
    },
    {
      ...valid,
      stages: valid.stages.map((stage, index) => index === 1
        ? {
          name: "igdb" as const,
          status: "not_run" as const,
          reason: "previous_stage_failed" as const,
          summary: "Stage not run: previous_stage_failed.",
        }
        : stage),
    },
    {
      ...valid,
      status: "failed" as const,
    },
    {
      ...valid,
      status: "failed" as const,
      stages: valid.stages.map((stage, index) => index === 2
        ? {
          name: "links" as const,
          status: "failed" as const,
          summary: "Stage failed.",
          error: { code: "timeout", message: "secret-bearing wrong message" },
        }
        : stage),
    },
  ];

  for (const game of malformed) {
    expectBatchFailure(() => assertCompleteBatch(
      completeResult([game as BulkGameResult]),
      ["10"],
      true,
    ));
  }
});

it("accepts only the complete dry-run create skip pattern", () => {
  const dryRunCreate: BulkGameResult = {
    appId: "10",
    gameId: null,
    status: "succeeded",
    stages: [
      { name: "steam", status: "succeeded", summary: "Steam create planned." },
      {
        name: "igdb",
        status: "not_run",
        reason: "canonical_game_not_persisted",
        summary: "Stage not run: canonical_game_not_persisted.",
      },
      {
        name: "links",
        status: "not_run",
        reason: "canonical_game_not_persisted",
        summary: "Stage not run: canonical_game_not_persisted.",
      },
      {
        name: "images",
        status: "not_run",
        reason: "canonical_game_not_persisted",
        summary: "Stage not run: canonical_game_not_persisted.",
      },
    ],
  };

  expect(() => assertCompleteBatch(completeResult([dryRunCreate]), ["10"], true))
    .not.toThrow();
  expectBatchFailure(() => assertCompleteBatch(
    completeResult([dryRunCreate], false),
    ["10"],
    false,
  ));
});
