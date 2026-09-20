import { describe, expect, it } from "vitest";
import { parseExportArgs, runExport } from "./export-site-data";
import type { SiteSnapshot } from "../lib/site-data/read-model";
import type { SiteSnapshotGame } from "../lib/site-data/read-model";
import type { RunSnapshot } from "../lib/pipeline/run-repository";
import type { PublishedGame } from "../lib/site-data/contracts";
import { hashManifest } from "../lib/pipeline/canonical";

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

describe("local site data export CLI", () => {
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
    await expect(runExport({ argv: ["--snapshot-date", "2026-09-19", "--selection", "selection.json", "--run-id", publication.snapshot.run.run_id], readSnapshot: async () => ({ games: [candidate] }), publication, readArtifact: async () => artifact, atomicReplace: async (_path, content) => { events.push(`replace:${content}`); artifact = content; }, repository: { admitExport: async () => { events.push("admit"); return admittedRun; }, completeExport: async (expected) => { events.push(`complete:${expected.run_id}:${expected.current_stage}`); throw new Error("CAS failed"); } } })).rejects.toThrow("CAS failed");
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
