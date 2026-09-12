import { expect, it, vi } from "vitest";
import { runBulkSyncGame } from "./game-pipeline";
import {
  stageError,
  type BulkSyncStages,
  type CanonicalSyncStage,
  type SteamSyncStage,
} from "./stages";
import type { StageName } from "./types";

function successfulStages(
  events: string[] = [],
  overrides: Partial<BulkSyncStages> = {},
): BulkSyncStages {
  const steam: SteamSyncStage = {
    execute: async (appId, context) => {
      events.push(`steam:${appId}:${context.dryRun}`);
      return { gameId: 41, action: "existing", summary: "Steam existing." };
    },
  };
  const canonical = (name: Exclude<StageName, "steam">): CanonicalSyncStage => ({
    execute: async (gameId, context) => {
      events.push(`${name}:${gameId}:${context.dryRun}`);
      return { summary: `${name} completed.` };
    },
  });
  return {
    steam,
    igdb: canonical("igdb"),
    links: canonical("links"),
    images: canonical("images"),
    ...overrides,
  };
}

it("new dry-run create skips canonical stages without inventing a game ID", async () => {
  const next = vi.fn();
  const result = await runBulkSyncGame({
    appId: "10",
    dryRun: true,
    stages: {
      steam: {
        execute: async () => ({
          gameId: null,
          action: "create",
          summary: "Steam create planned.",
        }),
      },
      igdb: { execute: next },
      links: { execute: next },
      images: { execute: next },
    },
  });

  expect(result).toEqual({
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
  });
  expect(next).not.toHaveBeenCalled();
});

it.each([
  { dryRun: true, mode: "true" },
  { dryRun: false, mode: "false" },
])("runs all four stages in fixed order in $mode mode", async ({ dryRun }) => {
  const events: string[] = [];

  const result = await runBulkSyncGame({
    appId: "10",
    dryRun,
    stages: successfulStages(events),
  });

  expect(events).toEqual([
    `steam:10:${dryRun}`,
    `igdb:41:${dryRun}`,
    `links:41:${dryRun}`,
    `images:41:${dryRun}`,
  ]);
  expect(result.status).toBe("succeeded");
  expect(result.gameId).toBe(41);
  expect(result.stages.map(({ name, status }) => [name, status])).toEqual([
    ["steam", "succeeded"],
    ["igdb", "succeeded"],
    ["links", "succeeded"],
    ["images", "succeeded"],
  ]);
});

it.each([
  { failedStage: "steam" as const, expectedCalls: [] },
  { failedStage: "igdb" as const, expectedCalls: ["steam"] },
  { failedStage: "links" as const, expectedCalls: ["steam", "igdb"] },
  { failedStage: "images" as const, expectedCalls: ["steam", "igdb", "links"] },
])("fails fast at the $failedStage stage", async ({ failedStage, expectedCalls }) => {
  const calls: StageName[] = [];
  const stages = successfulStages();
  stages.steam = {
    execute: async () => {
      if (failedStage === "steam") throw stageError("steam", "timeout");
      calls.push("steam");
      return { gameId: 41, action: "existing", summary: "Steam existing." };
    },
  };
  for (const name of ["igdb", "links", "images"] as const) {
    stages[name] = {
      execute: async () => {
        if (failedStage === name) throw stageError(name, "timeout");
        calls.push(name);
        return { summary: `${name} completed.` };
      },
    };
  }

  const result = await runBulkSyncGame({ appId: "10", dryRun: false, stages });

  expect(calls).toEqual(expectedCalls);
  expect(result.status).toBe("failed");
  expect(result.stages).toHaveLength(4);
  const failedIndex = ["steam", "igdb", "links", "images"].indexOf(failedStage);
  expect(result.stages[failedIndex]).toEqual({
    name: failedStage,
    status: "failed",
    summary: "Stage failed.",
    error: {
      code: "timeout",
      message: `Bulk sync ${failedStage} stage failed (timeout).`,
    },
  });
  expect(result.stages.slice(failedIndex + 1)).toEqual(
    (["steam", "igdb", "links", "images"] as const)
      .slice(failedIndex + 1)
      .map((name) => ({
        name,
        status: "not_run",
        reason: "previous_stage_failed",
        summary: "Stage not run: previous_stage_failed.",
      })),
  );
});

it.each([
  { dryRun: false, action: "create" as const, gameId: null },
  { dryRun: false, action: "existing" as const, gameId: null },
  { dryRun: true, action: "existing" as const, gameId: null },
  { dryRun: false, action: "create" as const, gameId: 0 },
  { dryRun: false, action: "create" as const, gameId: -1 },
  { dryRun: false, action: "create" as const, gameId: 1.5 },
  { dryRun: false, action: "create" as const, gameId: Number.NaN },
])(
  "rejects unusable canonical ID $gameId for $action with dryRun=$dryRun",
  async ({ dryRun, action, gameId }) => {
    const next = vi.fn();
    const result = await runBulkSyncGame({
      appId: "10",
      dryRun,
      stages: {
        steam: { execute: async () => ({ gameId, action, summary: "Steam result." }) },
        igdb: { execute: next },
        links: { execute: next },
        images: { execute: next },
      },
    });

    expect(result).toMatchObject({
      gameId: null,
      status: "failed",
      stages: [
        {
          name: "steam",
          status: "failed",
          error: { code: "invalid_result" },
        },
        { name: "igdb", status: "not_run", reason: "previous_stage_failed" },
        { name: "links", status: "not_run", reason: "previous_stage_failed" },
        { name: "images", status: "not_run", reason: "previous_stage_failed" },
      ],
    });
    expect(next).not.toHaveBeenCalled();
  },
);

it("redacts an unknown stage exception and keeps earlier completed stages", async () => {
  const images = vi.fn();
  const result = await runBulkSyncGame({
    appId: "10",
    dryRun: false,
    stages: successfulStages([], {
      links: {
        execute: async () => {
          throw new Error("token=do-not-leak");
        },
      },
      images: { execute: images },
    }),
  });

  expect(result.stages.slice(0, 2).map(({ status }) => status)).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect(result.stages[2]).toEqual({
    name: "links",
    status: "failed",
    summary: "Stage failed.",
    error: {
      code: "unexpected_error",
      message: "Bulk sync links stage failed (unexpected_error).",
    },
  });
  expect(JSON.stringify(result)).not.toContain("do-not-leak");
  expect(images).not.toHaveBeenCalled();
});
