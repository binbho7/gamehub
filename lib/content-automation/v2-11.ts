import { z } from "zod";
import { PublishedArtifactSchema, type PublishedArtifact, type PublishedGame } from "../site-data/contracts";
import { serializeArtifact } from "../site-data/serialize";

const appId = z.string().regex(/^[1-9][0-9]*$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const item = z.object({ steamAppId: appId, decision: z.enum(["include", "exclude"]) }).strict();

export const IncrementalSelectionSchema = z.object({
  selectionVersion: z.literal("2"), pipelineVersion: z.literal("2.10"),
  policyVersion: z.literal("v2.10-production-1"), snapshotDate: date,
  manifestHash: hash, publicationMode: z.literal("incremental"),
  baseArtifactSha256: hash, baseGameCount: z.number().int().nonnegative(),
  items: z.array(item).min(1).max(1000),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.items.forEach((entry, index) => {
    if (ids.has(entry.steamAppId)) ctx.addIssue({ code: "custom", path: ["items", index], message: "duplicate Steam App ID" });
    ids.add(entry.steamAppId);
  });
});

export type IncrementalSelection = z.infer<typeof IncrementalSelectionSchema>;

export function parseIncrementalSelection(value: unknown): IncrementalSelection {
  return IncrementalSelectionSchema.parse(value);
}

export function scanHistoricalManifestIds(manifests: readonly { items: readonly { steamAppId: string }[] }[]): string[] {
  return [...new Set(manifests.flatMap((manifest) => manifest.items.map((item) => item.steamAppId)))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function mergeIncrementalArtifact(
  base: PublishedArtifact,
  actualBaseSha256: string,
  selectionValue: unknown,
  additions: readonly PublishedGame[] = [],
): PublishedArtifact {
  const selection = parseIncrementalSelection(selectionValue);
  const validatedBase = PublishedArtifactSchema.parse(base);
  if (actualBaseSha256 !== selection.baseArtifactSha256) throw new Error("base artifact SHA mismatch");
  if (validatedBase.games.length !== selection.baseGameCount) throw new Error("base game count mismatch");
  const existing = new Set(validatedBase.games.map((game) => game.slug));
  for (const addition of additions) {
    if (existing.has(addition.slug)) throw new Error(`slug collision: ${addition.slug}`);
    existing.add(addition.slug);
  }
  return PublishedArtifactSchema.parse({
    ...validatedBase,
    snapshotDate: selection.snapshotDate,
    games: [...validatedBase.games, ...additions],
  });
}

export function serializeIncrementalArtifact(artifact: PublishedArtifact): string {
  return serializeArtifact(PublishedArtifactSchema.parse(artifact));
}
