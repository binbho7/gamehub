import { describe, expect, it } from "vitest";
import { acquirePublicationLock, parseExportArgs, runExport } from "./export-site-data";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { evaluateGames } from "../lib/site-data/eligibility";
import type { SiteSnapshot } from "../lib/site-data/read-model";
import type { SiteSnapshotGame } from "../lib/site-data/read-model";
import type { RunSnapshot } from "../lib/pipeline/run-repository";
import type { PublishedGame } from "../lib/site-data/contracts";
import { hashManifest } from "../lib/pipeline/canonical";
import { initialRunStages, parseRunStages, serializeRunStages } from "../lib/pipeline/state";
import { transitionRun } from "../lib/pipeline/transitions";
import type { RunRow } from "../lib/pipeline/run-repository";

const snapshot: SiteSnapshot = { games: [] };

const publishedGame = (slug: string): PublishedGame => ({
  slug, title: slug, description: "D", releaseDate: "2026-09-18", status: "released" as const,
  developer: "D", publisher: "P", genres: ["Action"], genreSlugs: ["action"], platforms: ["Windows"], platformSlugs: ["windows"],
  cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg",
  screenshots: [], officialLinks: [{ provider: "website", type: "official_website", url: "https://store.steampowered.com/app/1" }], videos: [],
  optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
});

const durablePublication = () => {
  const manifest = { manifestVersion: "1" as const, pipelineVersion: "2.10" as const, policyVersion: "policy", snapshotDate: "2026-09-19", items: [{ ordinal: 1, steamAppId: "1" }] };
  const stageStates = JSON.stringify({ discover: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, import: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, enrich: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, verify: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, images: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" }, evaluate: { state: "succeeded", attemptCount: 1, reasonCode: null, retryClass: "none" } });
  const manifestHash = hashManifest(manifest);
  return {
    selection: { selectionVersion: "1", pipelineVersion: "2.10", policyVersion: "policy", snapshotDate: "2026-09-19", manifestHash, items: [{ steamAppId: "1", decision: "include" }] },
    snapshot: { run: { run_id: `pipeline-v2.10:${manifestHash}`, manifest_hash: manifestHash, pipeline_version: "2.10", policy_version: "policy", snapshot_date: "2026-09-19" }, items: [{ ordinal: 1, steam_app_id: "1", game_id: 1, stage_states_json: stageStates }] } as unknown as RunSnapshot,
  };
};

const candidate = {
  game: { id: 1, slug: "game", title: "Game", summary: null, description: "Description", status: "released", releaseDate: "2026-09-18", coverUrl: "https://cdn.akamai.steamstatic.com/a.jpg", heroUrl: "https://images.igdb.com/a.jpg" },
  externalIds: [{ id: 1, gameId: 1, provider: "steam", externalId: "1", externalUrl: null }],
  companies: [{ id: 1, gameId: 1, slug: "dev", name: "Dev", websiteUrl: null, role: "developer" }, { id: 2, gameId: 1, slug: "pub", name: "Pub", websiteUrl: null, role: "publisher" }],
  genres: [{ id: 1, slug: "action", name: "Action" }], platforms: [{ id: 1, slug: "pc", name: "PC" }], images: [],
  officialLinks: [{ id: 1, gameId: 1, provider: "steam", platform: null, linkType: "official_website", url: "https://store.steampowered.com/app/1", region: null, isOfficial: true, verificationStatus: "verified", verificationMethod: "manual" }], videos: [],
} as unknown as SiteSnapshotGame;

async function serializedCandidateArtifact() {
  const publication = durablePublication();
  let artifact = "";
  await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
    readSnapshot: async () => ({ games: [candidate] }), publication,
    writeFile: async (path, content) => { if (path === "generated/site-data.json") artifact = content; },
    repository: {
      admitExport: async (expected) => ({ ...expected, status: "running", current_stage: "export" }),
      completeExport: async (expected) => expected,
    } });
  return artifact;
}

function publicationAtExport(state: "pending" | "running" | "retryable_failed", attemptCount: number) {
  const publication = durablePublication();
  const stages = initialRunStages();
  stages.export = { state, attemptCount, reasonCode: state === "retryable_failed" ? "interrupted" : null,
    retryClass: state === "retryable_failed" ? "retryable" : "none" };
  const run = { ...publication.snapshot.run, status: state === "retryable_failed" ? "paused" : "running",
    current_stage: "export", run_stage_states_json: serializeRunStages(stages), artifact_sha256: null,
    created_at: 0, updated_at: 0 } as RunRow;
  return { ...publication, snapshot: { ...publication.snapshot, run } };
}

function statefulExportRepository(publication: ReturnType<typeof publicationAtExport>, events: string[]) {
  let run = publication.snapshot.run;
  const apply = (event: Parameters<typeof transitionRun>[1]) => {
    const next = transitionRun({ status: run.status, currentStage: run.current_stage,
      stages: parseRunStages(run.run_stage_states_json), artifactSha256: run.artifact_sha256 }, event);
    run = { ...run, status: next.status, current_stage: next.currentStage,
      run_stage_states_json: serializeRunStages(next.stages), artifact_sha256: next.artifactSha256 };
    return run;
  };
  return {
    get run() { return run; },
    repository: {
      async transitionRun(expected: RunRow, event: Exclude<Parameters<typeof transitionRun>[1], { type: "admit_export" }>) {
        expect(expected).toBe(run); events.push(event.type); return apply(event);
      },
      async completeExport(expected: RunRow, _selection: unknown, artifactSha256: string) {
        expect(expected).toBe(run);
        const state = parseRunStages(run.run_stage_states_json).export.state;
        const event = state === "running" ? { type: "succeed" as const, artifactSha256 }
          : state === "retryable_failed" ? { type: "reconcile_succeed" as const, artifactSha256 }
            : { type: "complete_stage" as const, artifactSha256 };
        events.push(event.type); return apply(event);
      },
    },
  };
}

describe("local site data export CLI", () => {
  it.each([
    { standaloneFirst: true, same: false, rollback: false },
    { standaloneFirst: false, same: false, rollback: false },
    { standaloneFirst: true, same: true, rollback: false },
    { standaloneFirst: false, same: true, rollback: false },
    { standaloneFirst: false, same: true, rollback: true },
  ])("serializes standalone/durable transactions through completion and rollback: %j", async ({ standaloneFirst, same, rollback }) => {
    const root = await mkdtemp(join(tmpdir(), "export-ownership-"));
    const path = join(root, "site-data.json");
    let bytes = "previous reviewed artifact";
    const previousBytes = bytes;
    let durableSha: string | undefined;
    let signal!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    let held = true;
    const publication = durablePublication();
    const common = { argv: ["--snapshot-date", "2026-09-19"], readSnapshot: async () => ({ games: [candidate] }),
      readArtifact: async () => bytes,
      acquirePublicationLock: () => acquirePublicationLock(path),
    };
    const standalone = () => runExport({ ...common,
      evaluate: () => same ? evaluateGames([candidate], "2026-09-19") : [{ published: publishedGame("different"), diagnostics: [] }],
      atomicReplace: async (_path, content) => { bytes = content; if (standaloneFirst && held) { signal(); await blocked; } },
    });
    const durable = () => runExport({ ...common, publication,
      atomicReplace: async (_path, content) => {
        await expect(acquirePublicationLock(path)).rejects.toThrow("locked");
        bytes = content;
      }, repository: { completeExport: async (expected, _selection, sha) => {
        if (!standaloneFirst && held) { signal(); await blocked; }
        if (rollback && held) throw new Error("completion failed");
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
        durableSha = sha;
        return expected;
      }, fenceExportCompletion: async (expected) => ({ outcome: "missing" as const, run: expected }) },
    });
    try {
      const first = (standaloneFirst ? standalone() : durable()).then(() => null, (error: unknown) => error);
      await entered;
      await expect(standaloneFirst ? durable() : standalone()).rejects.toThrow("locked");
      finish();
      const failure = await first;
      if (rollback) { expect(failure).toMatchObject({ message: "completion failed" }); expect(bytes).toBe(previousBytes); }
      else expect(failure).toBeNull();
      held = false;
      await standalone();
      await durable();
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(durableSha);
    } finally { finish(); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["read", "admit", "replace", "complete"])("releases ownership when %s fails", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "export-failure-lock-"));
    const path = join(root, "artifact");
    const publication = durablePublication();
    const failAt = (at: string) => { if (phase === at) throw new Error("injected failure"); };
    let bytes = "previous";
    try {
      await expect(runExport({ argv: ["--snapshot-date", "2026-09-19"], publication,
        readSnapshot: async () => ({ games: [candidate] }),
        acquirePublicationLock: () => acquirePublicationLock(path),
        readArtifact: async () => { failAt("read"); return bytes; },
        atomicReplace: async (_path, content) => { failAt("replace"); bytes = content; },
        repository: {
          admitExport: async () => { failAt("admit"); return publication.snapshot.run; },
          completeExport: async () => { failAt("complete"); return publication.snapshot.run; },
        },
      })).rejects.toThrow("injected failure");
      const release = await acquirePublicationLock(path);
      await release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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

  it("requires a durable run id for the reviewed selection path", () => {
    expect(() => parseExportArgs(["--snapshot-date", "2026-09-19", "--selection", "selection.json"]))
      .toThrow(/durable run ID/i);
    expect(parseExportArgs(["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", `pipeline-v2.10:${"a".repeat(64)}`]))
      .toMatchObject({ selection: "selection.json" });
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
          slug: "a", title: "A", description: "D", releaseDate: "2026-09-18", status: "released", developer: "D", publisher: "P", genres: ["Action"], genreSlugs: ["action"], platforms: ["PC"], platformSlugs: ["pc"], cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg", screenshots: [], officialLinks: [{ provider: "website", type: "official_website", url: "https://store.steampowered.com/app/1" }], videos: [], optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
        },
        diagnostics: [],
      }],
    });
    expect(result).toMatchObject({ eligibleCount: 1, excludedCount: 0 });
    expect(writes.map((item) => item.path)).toEqual(["generated/export-report.json", "generated/site-data.json"]);
    expect(writes[0]!.content).not.toMatch(/raw|secret|storage|local|providerPayload/i);
  });

  it("returns the exact lowercase SHA-256 of the serialized artifact", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await runExport({
      argv: ["--snapshot-date", "2026-09-19"], readSnapshot: async () => snapshot,
      writeFile: async (path, content) => { writes.push({ path, content }); },
      evaluate: () => [{ published: publishedGame("hash"), diagnostics: [] }],
    });
    const { createHash } = await import("node:crypto");
    expect(result.artifactSha256).toBe(createHash("sha256").update(writes[1]!.content).digest("hex"));
    expect(result.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes publication order before validating and serializing", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const game = (slug: string) => ({
      slug, title: slug, description: "D", releaseDate: "2026-09-18", status: "released" as const,
      developer: "D", publisher: "P", genres: ["Z", "A"], genreSlugs: ["z", "a"], platforms: ["Windows", "Steam"], platformSlugs: ["windows", "steam"],
      cover: "https://cdn.akamai.steamstatic.com/a.jpg", hero: "https://images.igdb.com/a.jpg",
      screenshots: ["https://images.igdb.com/z.jpg", "https://cdn.akamai.steamstatic.com/a.jpg"],
      officialLinks: [
        { provider: "z", type: "official_website", url: "https://store.steampowered.com/app/2" },
        { provider: "a", type: "official_website", url: "https://store.steampowered.com/app/1" },
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

  it("preserves canonical screenshot and video presentation order", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const game = publishedGame("media-order");
    game.screenshots = ["https://images.igdb.com/first.jpg", "https://images.igdb.com/second.jpg"];
    game.videos = [
      { provider: "youtube", id: "b".repeat(11), title: "Second" },
      { provider: "youtube", id: "a".repeat(11), title: "First" },
    ];
    await runExport({ argv: ["--snapshot-date", "2026-09-19"], readSnapshot: async () => snapshot,
      evaluate: () => [{ published: game, diagnostics: [] }],
      writeFile: async (path, content) => { writes.push({ path, content }); } });
    const artifact = JSON.parse(writes[1]!.content) as { games: Array<{ screenshots: string[]; videos: Array<{ id: string }> }> };
    expect(artifact.games[0]!.screenshots).toEqual(game.screenshots);
    expect(artifact.games[0]!.videos.map((video) => video.id)).toEqual(game.videos.map((video) => video.id));
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

  it("rejects a CLI snapshot date different from the durable publication run before writing", async () => {
    const writes: string[] = [];
    const publicationSnapshot = {
      run: { snapshot_date: "2026-09-18" },
      items: [],
    } as unknown as import("../lib/pipeline/run-repository").RunSnapshot;
    await expect(runExport({
      argv: ["--snapshot-date", "2026-09-19"],
      readSnapshot: async () => snapshot,
      publication: { snapshot: publicationSnapshot, selection: {} },
      writeFile: async (path) => { writes.push(path); },
    })).rejects.toThrow(/snapshot date/i);
    expect(writes).toEqual([]);
  });

  it("admits durable export before replacement and restores the old artifact if completion CAS fails", async () => {
    const publication = durablePublication();
    let artifact = "old artifact";
    const events: string[] = [];
    const admittedRun = { ...publication.snapshot.run, status: "running", current_stage: "export", updated_at: 2 } as typeof publication.snapshot.run;
    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id], readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact, atomicReplace: async (_path, content) => { events.push(`replace:${content}`); artifact = content; }, repository: { admitExport: async () => { events.push("admit"); return admittedRun; }, completeExport: async (expected) => { events.push(`complete:${expected.run_id}:${expected.current_stage}`); throw new Error("CAS failed"); }, fenceExportCompletion: async (expected) => ({ outcome: "missing" as const, run: expected }) } })).rejects.toThrow("CAS failed");
    expect(events[0]).toBe("admit");
    expect(events.some((event) => event.startsWith("complete:") && event.endsWith(":export"))).toBe(true);
    expect(artifact).toBe("old artifact");
  });

  it("does not delete a concurrently-created artifact when rollback had no prior artifact", async () => {
    const publication = durablePublication();
    let artifact: string | null = null;
    const concurrent = "concurrent artifact";
    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id], readSnapshot: async () => ({ games: [candidate] }), publication,
      readArtifact: async () => artifact,
      atomicReplace: async (_path, content) => { artifact = content; if (artifact === content) artifact = concurrent; },
      repository: { admitExport: async () => publication.snapshot.run, completeExport: async () => { throw new Error("CAS failed"); } } })).rejects.toThrow("CAS failed");
    expect(artifact).toBe(concurrent);
  });

  it("removes an invocation-owned first production artifact when durable completion fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "export-first-artifact-"));
    const artifactPath = join(root, "site-data.json");
    const publication = durablePublication();
    const admittedRun = { ...publication.snapshot.run, status: "running", current_stage: "export" } as typeof publication.snapshot.run;
    try {
      await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
        readSnapshot: async () => ({ games: [candidate] }), publication, artifactPath,
        acquirePublicationLock: async () => async () => {},
        repository: { admitExport: async () => admittedRun, completeExport: async () => { throw new Error("CAS failed"); },
          fenceExportCompletion: async (expected) => ({ outcome: "missing" as const, run: expected }) },
      })).rejects.toThrow("CAS failed");
      await expect(readFile(artifactPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an unlocked injected first artifact when durable completion fails", async () => {
    const publication = durablePublication();
    let artifact: string | null = null;
    let removes = 0;
    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact,
      atomicReplace: async (_path, content) => { artifact = content; }, removeArtifact: async () => { removes += 1; },
      repository: { admitExport: async (expected) => ({ ...expected, status: "running", current_stage: "export" }),
        completeExport: async () => { throw new Error("CAS failed"); } },
    })).rejects.toThrow("CAS failed");
    expect(artifact).not.toBeNull();
    expect(removes).toBe(0);
  });

  it("retains the completion error, keeps the lock held, and attaches first-artifact rollback failure", async () => {
    const publication = durablePublication();
    const completionError = new Error("CAS failed");
    const rollbackError = new Error("delete failed");
    let lockHeld = false;
    const root = await mkdtemp(join(tmpdir(), "export-delete-failure-"));
    try {
      await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
        readSnapshot: async () => ({ games: [candidate] }), publication, artifactPath: join(root, "site-data.json"),
        acquirePublicationLock: async () => { lockHeld = true; return async () => { lockHeld = false; }; },
        removeArtifact: async () => { expect(lockHeld).toBe(true); throw rollbackError; },
        repository: { admitExport: async (expected) => ({ ...expected, status: "running", current_stage: "export" }),
          completeExport: async () => { throw completionError; },
          fenceExportCompletion: async (expected) => { expect(lockHeld).toBe(true); return { outcome: "missing" as const, run: expected }; } },
      })).rejects.toSatisfy((error: unknown) => error === completionError && (error as Error).cause === rollbackError);
      expect(lockHeld).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a replaced prior artifact when durable completion committed before response loss", async () => {
    const publication = publicationAtExport("pending", 0);
    const events: string[] = [];
    const stateful = statefulExportRepository(publication, events);
    const complete = stateful.repository.completeExport;
    let artifact = "old reviewed artifact";
    const repository = {
      ...stateful.repository,
      async completeExport(...args: Parameters<typeof complete>) {
        await complete(...args);
        throw new Error("response lost");
      },
      async fenceExportCompletion() {
        events.push("reconcile_completion");
        return { outcome: "consistent" as const, run: stateful.run };
      },
    };

    const result = await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact,
      atomicReplace: async (_path, content) => { artifact = content; }, repository });

    expect(events).toEqual(["complete_stage", "reconcile_completion"]);
    expect(result.artifactSha256).toBe(stateful.run.artifact_sha256);
    expect(createHash("sha256").update(artifact).digest("hex")).toBe(stateful.run.artifact_sha256);
    expect(artifact).not.toBe("old reviewed artifact");
  });

  it("keeps a first production artifact when durable completion committed before response loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "export-lost-response-"));
    const artifactPath = join(root, "site-data.json");
    const publication = publicationAtExport("pending", 0);
    const events: string[] = [];
    const stateful = statefulExportRepository(publication, events);
    const complete = stateful.repository.completeExport;
    const repository = {
      ...stateful.repository,
      async completeExport(...args: Parameters<typeof complete>) {
        await complete(...args);
        throw new Error("response lost");
      },
      async fenceExportCompletion() {
        events.push("reconcile_completion");
        return { outcome: "consistent" as const, run: stateful.run };
      },
    };
    try {
      const result = await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
        readSnapshot: async () => ({ games: [candidate] }), publication, artifactPath,
        acquirePublicationLock: async () => async () => {}, repository });
      const artifact = await readFile(artifactPath, "utf8");
      expect(result.artifactSha256).toBe(stateful.run.artifact_sha256);
      expect(createHash("sha256").update(artifact).digest("hex")).toBe(stateful.run.artifact_sha256);
      expect(events).toEqual(["complete_stage", "reconcile_completion"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles response loss on the matching-artifact shortcut", async () => {
    const artifact = await serializedCandidateArtifact();
    const publication = publicationAtExport("retryable_failed", 1);
    const events: string[] = [];
    const stateful = statefulExportRepository(publication, events);
    const complete = stateful.repository.completeExport;
    const repository = {
      ...stateful.repository,
      async completeExport(...args: Parameters<typeof complete>) {
        await complete(...args);
        throw new Error("response lost");
      },
      async fenceExportCompletion() {
        events.push("reconcile_completion");
        return { outcome: "consistent" as const, run: stateful.run };
      },
    };

    const result = await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact,
      atomicReplace: async () => { throw new Error("must not replace"); }, repository });
    expect(result.artifactSha256).toBe(stateful.run.artifact_sha256);
    expect(events).toEqual(["reconcile_succeed", "reconcile_completion"]);
  });

  it("rolls back only after reconciliation proves durable completion is missing", async () => {
    const publication = publicationAtExport("pending", 0);
    let artifact = "old reviewed artifact";
    const events: string[] = [];
    const repository = {
      completeExport: async () => { events.push("complete"); throw new Error("response lost"); },
      fenceExportCompletion: async (expected: RunRow) => { events.push("reconcile_completion"); return { outcome: "missing" as const, run: expected }; },
    };

    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact,
      atomicReplace: async (_path, content) => { artifact = content; }, repository })).rejects.toThrow("response lost");

    expect(events).toEqual(["complete", "reconcile_completion"]);
    expect(artifact).toBe("old reviewed artifact");
  });

  it("does not roll back when durable completion reconciliation reports conflict", async () => {
    const publication = publicationAtExport("pending", 0);
    let artifact = "old reviewed artifact";
    const events: string[] = [];
    const completionError = new Error("response lost");
    const repository = {
      completeExport: async () => { events.push("complete"); throw completionError; },
      fenceExportCompletion: async () => { events.push("reconcile_completion"); return { outcome: "conflict" as const }; },
    };

    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact,
      atomicReplace: async (_path, content) => { artifact = content; }, repository })).rejects.toSatisfy((error: unknown) =>
        error === completionError && (error as Error).cause instanceof Error);

    expect(events).toEqual(["complete", "reconcile_completion"]);
    expect(artifact).not.toBe("old reviewed artifact");
  });

  it("does not roll back when durable completion reconciliation itself fails", async () => {
    const publication = publicationAtExport("pending", 0);
    let artifact = "old reviewed artifact";
    const completionError = new Error("response lost");
    const reconciliationError = new Error("reload failed");
    const repository = {
      completeExport: async () => { throw completionError; },
      fenceExportCompletion: async () => { throw reconciliationError; },
    };

    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact,
      atomicReplace: async (_path, content) => { artifact = content; }, repository })).rejects.toSatisfy((error: unknown) =>
        error === completionError && (error as Error).cause === reconciliationError);

    expect(artifact).not.toBe("old reviewed artifact");
  });

  it("preserves completion error when rollback fails", async () => {
    const publication = durablePublication();
    const completionError = new Error("CAS failed");
    let replacements = 0;
    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id], readSnapshot: async () => ({ games: [candidate] }), publication,
      readArtifact: async () => "old artifact",
      atomicReplace: async () => { replacements += 1; if (replacements > 1) throw new Error("rollback failed"); },
      repository: { admitExport: async () => publication.snapshot.run, completeExport: async () => { throw completionError; } } })).rejects.toThrow("CAS failed");
  });

  it("completes against the exact durable row returned by admission", async () => {
    const publication = durablePublication();
    let durableRun = publication.snapshot.run;
    const calls: string[] = [];
    const repository = {
      admitExport: async (expected: typeof durableRun) => {
        if (expected !== durableRun) throw new Error("stale admission CAS");
        durableRun = { ...durableRun, status: "running", current_stage: "export" };
        calls.push("admit");
        return durableRun;
      },
      completeExport: async (expected: typeof durableRun, _selection: unknown, sha: string) => {
        if (expected !== durableRun) throw new Error("stale completion CAS");
        if (expected.current_stage !== "export") throw new Error("invalid completion stage");
        durableRun = { ...durableRun, status: "running", current_stage: "preview", artifact_sha256: sha };
        calls.push("complete");
        return durableRun;
      },
    };
    await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id], readSnapshot: async () => ({ games: [candidate] }), publication, writeFile: async () => {}, repository });
    expect(calls).toEqual(["admit", "complete"]);
    expect(durableRun.current_stage).toBe("preview");
    expect(durableRun.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recovers an already-admitted export without admitting it again", async () => {
    const publication = durablePublication();
    const admitted = { ...publication, snapshot: { ...publication.snapshot, run: { ...publication.snapshot.run, status: "running" as const, current_stage: "export" as const, run_stage_states_json: JSON.stringify({ export: { state: "running", attemptCount: 1, reasonCode: null, retryClass: "none" }, preview: { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" }, "publish-ready": { state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none" } }) } } };
    const events: string[] = [];
    await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id], readSnapshot: async () => ({ games: [candidate] }), publication: admitted,
      readArtifact: async () => "old artifact", writeFile: async () => {}, repository: {
        admitExport: async () => { events.push("admit"); return admitted.snapshot.run; },
        completeExport: async (expected) => { events.push(`complete:${expected.current_stage}`); return expected; },
      } });
    expect(events).toEqual(["complete:export"]);
  });

  it("reconciles a retryable export whose artifact already matches without a new attempt", async () => {
    const artifact = await serializedCandidateArtifact();
    const publication = publicationAtExport("retryable_failed", 1);
    const events: string[] = [];
    const stateful = statefulExportRepository(publication, events);

    await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact,
      atomicReplace: async () => { throw new Error("must not replace"); }, repository: stateful.repository });

    expect(events).toEqual(["reconcile_succeed"]);
    expect(parseRunStages(stateful.run.run_stage_states_json).export).toMatchObject({ state: "succeeded", attemptCount: 1 });
    expect(stateful.run.current_stage).toBe("preview");
  });

  it("resumes a retryable export with a missing effect and completes the running attempt", async () => {
    const publication = publicationAtExport("retryable_failed", 1);
    const events: string[] = [];
    const stateful = statefulExportRepository(publication, events);
    let replacements = 0;

    await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => "old",
      atomicReplace: async () => { replacements += 1; }, repository: stateful.repository });

    expect(events).toEqual(["resume", "succeed"]);
    expect(replacements).toBe(1);
    expect(parseRunStages(stateful.run.run_stage_states_json).export).toMatchObject({ state: "succeeded", attemptCount: 2 });
  });

  it("reconciles an already-running matching export without replacement or restart", async () => {
    const artifact = await serializedCandidateArtifact();
    const publication = publicationAtExport("running", 1);
    const events: string[] = [];
    const stateful = statefulExportRepository(publication, events);

    await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact,
      atomicReplace: async () => { throw new Error("must not replace"); }, repository: stateful.repository });

    expect(events).toEqual(["succeed"]);
    expect(parseRunStages(stateful.run.run_stage_states_json).export).toMatchObject({ state: "succeeded", attemptCount: 1 });
  });

  it("recovers an already-running missing export effect before replay", async () => {
    const publication = publicationAtExport("running", 1);
    const events: string[] = [];
    const stateful = statefulExportRepository(publication, events);
    let replacements = 0;

    await runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => "old",
      atomicReplace: async () => { replacements += 1; }, repository: stateful.repository });

    expect(events).toEqual(["fail", "resume", "succeed"]);
    expect(replacements).toBe(1);
    expect(parseRunStages(stateful.run.run_stage_states_json).export).toMatchObject({ state: "succeeded", attemptCount: 2 });
  });

  it.each(["running", "retryable_failed"] as const)("does not create attempt four for an exhausted %s export", async (state) => {
    const publication = publicationAtExport(state, 3);
    const events: string[] = [];
    const stateful = statefulExportRepository(publication, events);
    let replacements = 0;

    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => "old",
      atomicReplace: async () => { replacements += 1; }, repository: stateful.repository })).rejects.toThrow("retry budget exhausted");

    expect(events).toEqual(state === "running" ? ["fail", "retry_exhausted"] : ["retry_exhausted"]);
    expect(replacements).toBe(0);
    expect(parseRunStages(stateful.run.run_stage_states_json).export).toMatchObject({ state: "permanently_failed", attemptCount: 3, reasonCode: "retry_exhausted" });
  });

  it("acquires publication lock before reading a shared artifact for matching completion", async () => {
    const publication = durablePublication();
    const events: string[] = [];
    await runExport({
      argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }), publication,
      acquirePublicationLock: async () => {
        events.push("lock:acquired");
        return async () => { events.push("lock:released"); };
      },
      readArtifact: async () => { events.push("artifact:read"); return "not-matching"; },
      atomicReplace: async () => { events.push("replace"); },
      repository: { completeExport: async () => { events.push("complete"); return publication.snapshot.run; } },
    });
    expect(events.indexOf("lock:acquired")).toBeLessThan(events.indexOf("artifact:read"));
    expect(events.at(-1)).toBe("lock:released");
  });

  it("locks standalone production artifact replacement", async () => {
    const events: string[] = [];
    await runExport({
      argv: ["--snapshot-date", "2026-09-19"],
      readSnapshot: async () => ({ games: [] }),
      evaluate: () => [{ published: publishedGame("standalone"), diagnostics: [] }],
      acquirePublicationLock: async () => {
        events.push("lock:acquired");
        return async () => { events.push("lock:released"); };
      },
      atomicReplace: async () => { events.push("replace"); },
    });
    expect(events).toEqual(["lock:acquired", "replace", "lock:released"]);
  });

  it("fails closed when reading the prior artifact has a non-ENOENT error", async () => {
    const publication = durablePublication();
    let admitted = false;
    await expect(runExport({
      argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }),
      publication,
      readArtifact: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
      atomicReplace: async () => { throw new Error("must not replace"); },
      repository: {
        admitExport: async () => { admitted = true; return publication.snapshot.run; },
        completeExport: async () => { throw new Error("must not complete"); },
      },
    })).rejects.toThrow("permission denied");
    expect(admitted).toBe(false);
  });

  it("reconciles durable export failure when replacement fails after admission", async () => {
    const publication = durablePublication();
    const admittedRun = { ...publication.snapshot.run, status: "running", current_stage: "export" } as typeof publication.snapshot.run;
    const artifact = "old artifact";
    const events: string[] = [];
    await expect(runExport({
      argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }),
      publication,
      readArtifact: async () => artifact,
      atomicReplace: async () => { events.push("replace"); throw new Error("rename failed"); },
      repository: {
        admitExport: async () => { events.push("admit"); return admittedRun; },
        reconcileExportFailure: async (expected) => { events.push(`reconcile:${expected.current_stage}`); return expected; },
        completeExport: async () => { throw new Error("must not complete"); },
      },
    })).rejects.toThrow("rename failed");
    expect(events).toEqual(["admit", "replace", "reconcile:export"]);
    expect(artifact).toBe("old artifact");
  });

  it("preserves replacement error when export failure reconciliation also fails", async () => {
    const publication = durablePublication();
    const replacementError = new Error("rename failed");
    const reconcileError = new Error("reconcile failed");
    await expect(runExport({
      argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id],
      readSnapshot: async () => ({ games: [candidate] }),
      publication,
      readArtifact: async () => "old artifact",
      atomicReplace: async () => { throw replacementError; },
      repository: {
        admitExport: async () => ({ ...publication.snapshot.run, status: "running", current_stage: "export" } as typeof publication.snapshot.run),
        reconcileExportFailure: async () => { throw reconcileError; },
        completeExport: async () => { throw new Error("must not complete"); },
      },
    })).rejects.toSatisfy((error: unknown) => error === replacementError && (error as Error).cause === reconcileError);
  });

});
