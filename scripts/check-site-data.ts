import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertArtifactLimits } from "../lib/site-data/serialize";
import { validateArtifact } from "../lib/site-data/validation";

export type CheckResult = { valid: boolean; diagnostics: string[] };
type ReadText = () => Promise<string | undefined>;

export async function checkSiteData(options: { readText: ReadText }): Promise<CheckResult> {
  const diagnostics: string[] = [];
  const raw = await options.readText().catch(() => undefined);
  if (raw === undefined) return { valid: false, diagnostics: ["artifact_missing"] };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { valid: false, diagnostics: ["invalid_json"] };
  }
  try {
    const artifact = validateArtifact(value);
    assertArtifactLimits(raw, artifact.games.length);
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : "invalid_artifact");
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

async function main() {
  const result = await checkSiteData({ readText: async () => readFile(resolve("generated/site-data.json"), "utf8") });
  if (!result.valid) {
    for (const diagnostic of result.diagnostics) console.error(diagnostic);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("check-site-data.ts")) void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
