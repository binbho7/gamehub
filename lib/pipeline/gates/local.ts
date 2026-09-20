import { createHash } from "node:crypto";

export type LocalGateStage = "preview" | "publish-ready";

export type LocalGateFs = {
  read(path: string): Promise<string | undefined>;
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

/**
 * Runs a local-only gate against isolated temporary paths. The gate has no
 * publish side effect: callers advance the operational ledger only after this
 * function resolves successfully.
 */
export async function runLocalGate(input: LocalGateInput): Promise<{ artifactSha256: string }> {
  const actualSha = sha256(input.artifact);
  if (input.artifactSha256 === null || !/^[0-9a-f]{64}$/.test(input.artifactSha256) || actualSha !== input.artifactSha256) {
    throw new Error("artifact SHA-256 mismatch");
  }

  const root = `${input.tempRoot ?? ".tmp/v2.10"}/${input.runId}/${input.stage}`;
  const artifactPath = `${root}/site-data.json`;
  const outputPath = `${root}/out`;
  await input.fs.write(artifactPath, input.artifact);
  await input.checkSiteData(artifactPath);
  await input.build(artifactPath, outputPath);
  await input.fs.write(`${root}/gate-complete.json`, JSON.stringify({ artifactSha256: actualSha }));
  return { artifactSha256: actualSha };
}

export async function reconcileLocalGate(input: Pick<LocalGateInput, "runId" | "stage" | "artifact" | "artifactSha256" | "fs" | "tempRoot">): Promise<{ outcome: "consistent"; artifactSha256: string } | { outcome: "missing" | "conflict" }> {
  const actualSha = sha256(input.artifact);
  const root = `${input.tempRoot ?? ".tmp/v2.10"}/${input.runId}/${input.stage}`;
  const storedArtifact = await input.fs.read(`${root}/site-data.json`);
  const completion = await input.fs.read(`${root}/gate-complete.json`);
  const exportedIndex = await input.fs.read(`${root}/out/index.html`);
  if (storedArtifact === undefined || completion === undefined || exportedIndex === undefined) return { outcome: "missing" };
  if (input.artifactSha256 === null || !/^[0-9a-f]{64}$/.test(input.artifactSha256) || actualSha !== input.artifactSha256) return { outcome: "conflict" };
  if (storedArtifact !== input.artifact) return { outcome: "conflict" };
  try {
    const parsed = JSON.parse(completion) as { artifactSha256?: unknown };
    if (parsed.artifactSha256 !== actualSha) return { outcome: "conflict" };
  } catch {
    return { outcome: "conflict" };
  }
  return { outcome: "consistent", artifactSha256: actualSha };
}

export const runPreviewGate = (input: Omit<LocalGateInput, "stage">) => runLocalGate({ ...input, stage: "preview" });
export const runPublishReadyGate = (input: Omit<LocalGateInput, "stage">) => runLocalGate({ ...input, stage: "publish-ready" });
