import { z } from "zod";

const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const STEAM_APP_ID_PATTERN = /^[1-9][0-9]*$/;
const MANIFEST_HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_ITEMS = 1_000;

function isExactCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const ExactCalendarDateSchema = z.string().refine(isExactCalendarDate, {
  message: "date must be a real calendar date in exact YYYY-MM-DD form",
});

const ManifestItemSchema = z.object({
  ordinal: z.number().int().positive(),
  steamAppId: z.string().regex(STEAM_APP_ID_PATTERN),
}).strict();

export const InputManifestSchema = z.object({
  manifestVersion: z.literal("1"),
  pipelineVersion: z.literal("2.10"),
  policyVersion: z.string().regex(POLICY_VERSION_PATTERN),
  snapshotDate: ExactCalendarDateSchema,
  items: z.array(ManifestItemSchema).min(1).max(MAX_MANIFEST_ITEMS),
}).strict().superRefine((manifest, context) => {
  const seenAppIds = new Set<string>();
  manifest.items.forEach((item, index) => {
    if (item.ordinal !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "ordinal"],
        message: "ordinals must be contiguous, one-based, and in array order",
      });
    }
    if (seenAppIds.has(item.steamAppId)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "steamAppId"],
        message: "Steam App IDs must be unique",
      });
    }
    seenAppIds.add(item.steamAppId);
  });
});

const PublicationSelectionItemSchema = z.object({
  steamAppId: z.string().regex(STEAM_APP_ID_PATTERN),
  decision: z.enum(["include", "exclude"]),
}).strict();

export const PublicationSelectionSchema = z.object({
  selectionVersion: z.literal("1"),
  pipelineVersion: z.literal("2.10"),
  policyVersion: z.string().regex(POLICY_VERSION_PATTERN),
  snapshotDate: ExactCalendarDateSchema,
  manifestHash: z.string().regex(MANIFEST_HASH_PATTERN),
  items: z.array(PublicationSelectionItemSchema).min(1).max(MAX_MANIFEST_ITEMS),
}).strict().superRefine((selection, context) => {
  const seenAppIds = new Set<string>();
  selection.items.forEach((item, index) => {
    if (seenAppIds.has(item.steamAppId)) {
      context.addIssue({
        code: "custom",
        path: ["items", index, "steamAppId"],
        message: "selection Steam App IDs must be unique",
      });
    }
    seenAppIds.add(item.steamAppId);
  });
});

export type InputManifest = z.infer<typeof InputManifestSchema>;
export type PublicationSelection = z.infer<typeof PublicationSelectionSchema>;

export type PublicationSelectionContext = {
  manifest: InputManifest;
  manifestHash: string;
};

export function parseInputManifest(value: unknown): InputManifest {
  return InputManifestSchema.parse(value);
}

export function parsePublicationSelection(
  value: unknown,
  context: PublicationSelectionContext,
): PublicationSelection {
  const selection = PublicationSelectionSchema.parse(value);
  const manifest = InputManifestSchema.parse(context.manifest);
  const manifestHash = z.string().regex(MANIFEST_HASH_PATTERN).parse(context.manifestHash);

  if (selection.manifestHash !== manifestHash) {
    throw new Error("publication selection manifestHash does not match");
  }
  if (selection.pipelineVersion !== manifest.pipelineVersion) {
    throw new Error("publication selection pipelineVersion does not match");
  }
  if (selection.policyVersion !== manifest.policyVersion) {
    throw new Error("publication selection policyVersion does not match");
  }
  if (selection.snapshotDate !== manifest.snapshotDate) {
    throw new Error("publication selection snapshotDate does not match");
  }

  const manifestIds = new Set(manifest.items.map((item) => item.steamAppId));
  const selectionIds = new Set(selection.items.map((item) => item.steamAppId));
  if (manifestIds.size !== selectionIds.size
    || [...manifestIds].some((steamAppId) => !selectionIds.has(steamAppId))) {
    throw new Error("publication selection must cover every manifest Steam App ID exactly once");
  }

  return selection;
}

