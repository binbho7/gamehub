import { createHash } from "node:crypto";
import { isAdapterFailureReason, normalizeSystemReason } from "../retry";

export type LocalGateStage = "preview" | "publish-ready";

export type LocalGateFs = {
  read(path: string): Promise<string | undefined>;
  list(path: string): Promise<string[]>;
  remove(path: string): Promise<void>;
  write(path: string, value: string): Promise<void>;
};

export type LocalGateInput = {
  runId: string;
  stage: LocalGateStage;
  artifact: string;
  artifactSha256: string | null;
  fs: LocalGateFs;
  checkSiteData: (artifactPath: string) => Promise<void>;
  build: (artifactPath: string, outputPath: string) => Promise<void>;
  tempRoot?: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function gateError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function stableExecutionFailure(error: unknown, fallbackCode: string, fallbackMessage: string): Error & { code: string } {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
  if (code !== null) {
    const normalized = normalizeSystemReason(code);
    if (isAdapterFailureReason(normalized)) {
      return gateError(normalized, fallbackMessage);
    }
    return gateError("composition_failure", fallbackMessage);
  }
  return gateError(fallbackCode, fallbackMessage);
}

type OutputManifest = { files: Array<{ path: string; sha256: string; size: number }> };

const gateLocks = new Map<string, Promise<void>>();

function isCompleteHtml(value: string): boolean {
  const normalized = value.trim();
  return [
    "<!doctype html>",
    "<html",
    "</html>",
    "<head",
    "</head>",
    "<body",
    "</body>",
    "<main",
    "</main>",
  ].every((marker) => normalized.toLowerCase().includes(marker));
}

async function outputManifest(fs: LocalGateFs, outputPath: string): Promise<{ manifest: OutputManifest; hash: string } | undefined> {
  const paths = (await fs.list(outputPath)).sort();
  if (paths.length === 0 || !paths.includes(`${outputPath}/index.html`)) return undefined;
  const files: OutputManifest["files"] = [];
  for (const path of paths) {
    const value = await fs.read(path);
    if (value === undefined || value.trim().length === 0) return undefined;
    if (path === `${outputPath}/index.html` && !isCompleteHtml(value)) return undefined;
    files.push({ path: path.slice(outputPath.length + 1), sha256: sha256(value), size: Buffer.byteLength(value, "utf8") });
  }
  const manifest = { files } satisfies OutputManifest;
  return { manifest, hash: sha256(JSON.stringify(manifest)) };
}

/**
 * Runs a local-only gate against isolated temporary paths. The gate has no
 * publish side effect: callers advance the operational ledger only after this
 * function resolves successfully.
 */
export async function runLocalGate(input: LocalGateInput): Promise<{ artifactSha256: string }> {
  const lockKey = `${input.tempRoot ?? ".tmp/v2.10"}/${input.runId}/${input.stage}`;
  const previous = gateLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  gateLocks.set(lockKey, queued);
  await previous;
  try {
    return await runLocalGateLocked(input);
  } finally {
    release();
    if (gateLocks.get(lockKey) === queued) gateLocks.delete(lockKey);
  }
}

async function runLocalGateLocked(input: LocalGateInput): Promise<{ artifactSha256: string }> {
  const actualSha = sha256(input.artifact);
  if (input.artifactSha256 === null || !/^[0-9a-f]{64}$/.test(input.artifactSha256) || actualSha !== input.artifactSha256) {
    throw gateError("artifact_mismatch", "artifact SHA-256 mismatch");
  }

  const root = `${input.tempRoot ?? ".tmp/v2.10"}/${input.runId}/${input.stage}`;
  const artifactPath = `${root}/site-data.json`;
  const outputPath = `${root}/out`;
  for (const path of await input.fs.list(root)) await input.fs.remove(path);
  await input.fs.write(artifactPath, input.artifact);
  try { await input.checkSiteData(artifactPath); }
  catch (error) { throw stableExecutionFailure(error, "site_data_check_failed", "site-data check failed"); }
  try { await input.build(artifactPath, outputPath); }
  catch (error) { throw stableExecutionFailure(error, "build_failed", "local build failed"); }
  const output = await outputManifest(input.fs, outputPath);
  if (!output) throw gateError("build_output_invalid", "build output manifest unavailable");
  await input.fs.write(`${root}/gate-complete.json`, JSON.stringify({ artifactSha256: actualSha, outputManifest: output.manifest, outputManifestSha256: output.hash }));
  return { artifactSha256: actualSha };
}

export async function reconcileLocalGate(input: Pick<LocalGateInput, "runId" | "stage" | "artifact" | "artifactSha256" | "fs" | "tempRoot">): Promise<{ outcome: "consistent"; artifactSha256: string } | { outcome: "missing" | "conflict" }> {
  const actualSha = sha256(input.artifact);
  const root = `${input.tempRoot ?? ".tmp/v2.10"}/${input.runId}/${input.stage}`;
  const storedArtifact = await input.fs.read(`${root}/site-data.json`);
  const completion = await input.fs.read(`${root}/gate-complete.json`);
  if (storedArtifact === undefined || completion === undefined) return { outcome: "missing" };
  if (input.artifactSha256 === null || !/^[0-9a-f]{64}$/.test(input.artifactSha256) || actualSha !== input.artifactSha256) return { outcome: "conflict" };
  if (storedArtifact !== input.artifact) return { outcome: "conflict" };
  try {
    const parsed = JSON.parse(completion) as { artifactSha256?: unknown; outputManifestSha256?: unknown; outputManifest?: unknown };
    if (parsed.artifactSha256 !== actualSha || typeof parsed.outputManifestSha256 !== "string" || !parsed.outputManifest) return { outcome: "conflict" };
    const output = await outputManifest(input.fs, `${root}/out`);
    if (!output) return { outcome: (await input.fs.list(`${root}/out`)).length > 0 ? "conflict" : "missing" };
    if (output.hash !== parsed.outputManifestSha256 || JSON.stringify(output.manifest) !== JSON.stringify(parsed.outputManifest)) return { outcome: "conflict" };
  } catch {
    return { outcome: "conflict" };
  }
  return { outcome: "consistent", artifactSha256: actualSha };
}

export const runPreviewGate = (input: Omit<LocalGateInput, "stage">) => runLocalGate({ ...input, stage: "preview" });
export const runPublishReadyGate = (input: Omit<LocalGateInput, "stage">) => runLocalGate({ ...input, stage: "publish-ready" });
