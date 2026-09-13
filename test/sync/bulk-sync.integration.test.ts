import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { startBulkSyncHarness } from "./local-bulk-harness";

function parseBatch(stdout: string[]): {
  total: number;
  succeeded: number;
  failed: number;
  games: Array<{
    appId: string;
    gameId: number | null;
    status: string;
    stages: Array<{ name: string; status: string; reason?: string; summary: string }>;
  }>;
} {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]!);
}

it("Steam write is visible to IGDB links and the real image Worker", async () => {
  const harness = await startBulkSyncHarness();
  try {
    const result = await harness.run(["10", "--write", "--json"]);
    expect(result.exitCode).toBe(0);
    const batch = JSON.parse(result.stdout[0]!);
    const gameId = batch.games[0].gameId;
    expect(batch.games[0].stages.map((stage: { status: string }) => stage.status))
      .toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(await harness.read(
      "SELECT provider, external_id FROM game_external_ids WHERE game_id = ? ORDER BY provider",
      gameId,
    )).toEqual([
      { provider: "igdb", external_id: "1010" },
      { provider: "steam", external_id: "10" },
    ]);
    expect(harness.events).toContain("igdb mapping uid=10");
    expect(harness.events).toContain("verify https://official.example/game/1010");
    expect(harness.imageResponses[0]).toMatchObject({
      gameId,
      status: "completed",
      plan: { gameId, gameSnapshot: { id: gameId } },
    });
    const rows = await harness.read(
      "SELECT storage_key, content_hash FROM game_images WHERE game_id = ?",
      gameId,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => (
      typeof row.storage_key === "string" && typeof row.content_hash === "string"
    ))).toBe(true);
    expect(harness.mutations.r2Puts).toBeGreaterThan(0);
    expect(result.stderr).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

it("existing dry-run performs provider checks and zero D1 or R2 writes", async () => {
  const harness = await startBulkSyncHarness();
  try {
    harness.events.length = 0;
    harness.imageResponses.length = 0;
    harness.mutations.d1 = 0;
    harness.mutations.r2Heads = 0;
    harness.mutations.r2Puts = 0;
    const before = await harness.snapshot();

    const result = await harness.run(["40", "--json"]);
    const batch = parseBatch(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(batch.games[0]?.stages.map(({ status }) => status))
      .toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(harness.events).toContain("steam appdetails uid=40");
    expect(harness.events).toContain("igdb mapping uid=40");
    expect(harness.events).toContain("verify https://official.example/game/1040");
    expect(harness.events).toContain("image source GET");
    expect(harness.imageResponses[0]).toMatchObject({
      gameId: 4000,
      status: "completed",
      images: [{ outcome: "ingested", contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    });
    expect(harness.mutations.r2Heads).toBeGreaterThan(0);
    expect(harness.mutations.r2Puts).toBe(0);
    expect(harness.mutations.d1).toBe(0);
    expect(await harness.snapshot()).toEqual(before);
  } finally {
    await harness.close();
  }
}, 60_000);

it("fully-ingested dry-run uses the HEAD-only already_ingested path", async () => {
  const harness = await startBulkSyncHarness();
  try {
    harness.events.length = 0;
    harness.imageResponses.length = 0;
    harness.mutations.d1 = 0;
    harness.mutations.r2Heads = 0;
    harness.mutations.r2Puts = 0;
    const before = await harness.snapshot();

    const result = await harness.run(["50", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(harness.imageResponses[0]).toMatchObject({
      gameId: 5000,
      status: "completed",
      images: [{ imageId: 5050, outcome: "already_ingested" }],
    });
    expect(harness.events).not.toContain("image source GET");
    expect(harness.mutations).toEqual({ d1: 0, r2Heads: 1, r2Puts: 0 });
    expect(await harness.snapshot()).toEqual(before);
  } finally {
    await harness.close();
  }
}, 60_000);

it("new dry-run has no canonical state and three not_run stages", async () => {
  const harness = await startBulkSyncHarness();
  try {
    harness.events.length = 0;
    harness.imageResponses.length = 0;
    harness.mutations.d1 = 0;
    harness.mutations.r2Heads = 0;
    harness.mutations.r2Puts = 0;
    const before = await harness.snapshot();

    const result = await harness.run(["30", "--json"]);
    const batch = parseBatch(result.stdout);
    const game = batch.games[0]!;

    expect(result.exitCode).toBe(0);
    expect(game.gameId).toBeNull();
    expect(game.status).toBe("succeeded");
    expect(game.stages.map(({ status }) => status))
      .toEqual(["succeeded", "not_run", "not_run", "not_run"]);
    expect(game.stages.slice(1).map(({ reason }) => reason))
      .toEqual(Array(3).fill("canonical_game_not_persisted"));
    expect(harness.events).toContain("steam appdetails uid=30");
    expect(harness.events).not.toContain("igdb mapping uid=30");
    expect(harness.events.some((event) => event.includes("game/1030"))).toBe(false);
    expect(harness.imageResponses).toEqual([]);
    expect(harness.mutations).toEqual({ d1: 0, r2Heads: 0, r2Puts: 0 });
    expect(await harness.snapshot()).toEqual(before);
  } finally {
    await harness.close();
  }
}, 60_000);

it("failed game retains prior writes and next game completes", async () => {
  const harness = await startBulkSyncHarness();
  try {
    harness.rejectedIgdbAppIds.add("20");
    const result = await harness.run(["10", "20", "30", "--write", "--json"]);
    const batch = parseBatch(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(batch).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    expect(batch.games.map(({ appId, status }) => [appId, status])).toEqual([
      ["10", "succeeded"],
      ["20", "failed"],
      ["30", "succeeded"],
    ]);
    expect(batch.games[1]?.stages.map(({ status }) => status))
      .toEqual(["succeeded", "failed", "not_run", "not_run"]);
    expect(batch.games[1]?.stages.slice(2).map(({ reason }) => reason))
      .toEqual(["previous_stage_failed", "previous_stage_failed"]);
    expect(await harness.read(
      "SELECT external_id FROM game_external_ids WHERE provider = 'steam' AND external_id = '20'",
    )).toEqual([{ external_id: "20" }]);
    expect(await harness.read(
      "SELECT count(*) AS count FROM game_official_links l JOIN game_external_ids e ON e.game_id=l.game_id WHERE e.provider='steam' AND e.external_id='20' AND l.provider='igdb'",
    )).toEqual([{ count: 0 }]);
    expect(await harness.read(
      "SELECT count(*) AS count FROM game_images i JOIN game_external_ids e ON e.game_id=i.game_id WHERE e.provider='steam' AND e.external_id='20' AND i.storage_key IS NOT NULL",
    )).toEqual([{ count: 0 }]);
    expect(harness.events.filter((event) => event === "igdb mapping uid=20")).toHaveLength(1);
    expect(harness.events).toContain("igdb mapping uid=30");
    expect(harness.imageResponses.some(({ gameId }) => gameId === batch.games[2]?.gameId)).toBe(true);
  } finally {
    await harness.close();
  }
}, 60_000);

it("repeat write reuses identities and image objects", async () => {
  const harness = await startBulkSyncHarness();
  try {
    const first = parseBatch((await harness.run(["10", "--write", "--json"])).stdout);
    const gameId = first.games[0]!.gameId;
    const identities = await harness.read(
      "SELECT provider, external_id FROM game_external_ids WHERE game_id = ? ORDER BY provider, external_id",
      gameId,
    );
    const images = await harness.read(
      "SELECT id, source_url, storage_key, content_hash FROM game_images WHERE game_id = ? ORDER BY id",
      gameId,
    );
    const putsAfterFirst = harness.mutations.r2Puts;

    const second = parseBatch((await harness.run(["10", "--write", "--json"])).stdout);
    const secondImageResponse = harness.imageResponses.at(-1);

    expect(second).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect(second.games[0]?.gameId).toBe(gameId);
    expect(await harness.read(
      "SELECT provider, external_id FROM game_external_ids WHERE game_id = ? ORDER BY provider, external_id",
      gameId,
    )).toEqual(identities);
    expect(await harness.read(
      "SELECT id, source_url, storage_key, content_hash FROM game_images WHERE game_id = ? ORDER BY id",
      gameId,
    )).toEqual(images);
    expect(secondImageResponse?.images.every(({ outcome }) => [
      "deduplicated", "concurrent_dedup", "already_ingested", "restored", "skipped",
    ].includes(outcome))).toBe(true);
    expect(harness.mutations.r2Puts).toBe(putsAfterFirst);
  } finally {
    await harness.close();
  }
}, 60_000);

it("shared-state operator configuration matches local identity", () => {
  const root = new URL("../../", import.meta.url);
  const rootConfig = JSON.parse(readFileSync(new URL("wrangler.jsonc", root), "utf8"));
  const workerConfig = JSON.parse(readFileSync(new URL("workers/image-ingest/wrangler.jsonc", root), "utf8"));
  const rootD1 = rootConfig.d1_databases[0];
  const workerD1 = workerConfig.d1_databases[0];
  expect({
    database_name: workerD1.database_name,
    database_id: workerD1.database_id,
    preview_database_id: workerD1.preview_database_id,
  }).toEqual({
    database_name: rootD1.database_name,
    database_id: rootD1.database_id,
    preview_database_id: rootD1.preview_database_id,
  });
  const composition = readFileSync(new URL("scripts/sync-composition.ts", root), "utf8");
  const workerHelper = readFileSync(new URL("test/helpers/local-image-worker.ts", root), "utf8");
  const readme = readFileSync(new URL("README.md", root), "utf8");
  expect(composition).toContain(".wrangler/state/v3");
  expect(workerHelper).toContain("persist: { path: `${persistPath}/v3` }");
  expect(workerHelper).toContain('"--persist-to", persistPath');
  expect(readme).toContain("--persist-to .wrangler/state --port 8787");
  expect(readme).toContain("same repository `.wrangler/state/v3` and local `gamehub` D1 identity");
});

it("integration is local only and closes owned resources on failure", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(8787, "127.0.0.1", resolve);
  });
  try {
    await expect(startBulkSyncHarness()).rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => error ? reject(error) : resolve());
    });
  }

  const harness = await startBulkSyncHarness();
  try {
    const result = await harness.run(["99", "--write", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(harness.events).toContain("unexpected Steam App ID 99");
    expect(harness.events.every((event) => (
      !event.includes("http://") || event.startsWith("verify https://")
    ))).toBe(true);
  } finally {
    await harness.close();
    await harness.close();
  }

  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(8787, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
}, 60_000);
