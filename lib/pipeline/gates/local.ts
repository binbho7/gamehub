import { createHash } from "node:crypto";

export type LocalGateStage = "preview" | "publish-ready";

export type LocalGateFs = {
  read(path: string): Promise<string | undefined>;
  write(path: string, value: string): Promise<void>;
};

export type LocalGateInput = {
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

  const root = `${input.tempRoot ?? ".tmp/v2.10"}/${input.stage}`;
  const artifactPath = `${root}/site-data.json`;
  const outputPath = `${root}/out`;
  await input.fs.write(artifactPath, input.artifact);
  await input.checkSiteData(artifactPath);
  await input.build(artifactPath, outputPath);
  return { artifactSha256: actualSha };
}

export const runPreviewGate = (input: Omit<LocalGateInput, "stage">) => runLocalGate({ ...input, stage: "preview" });
export const runPublishReadyGate = (input: Omit<LocalGateInput, "stage">) => runLocalGate({ ...input, stage: "publish-ready" });
