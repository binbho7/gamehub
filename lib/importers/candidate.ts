import { z } from "zod";
import {
  createGameSchema,
  externalIdSchema,
  gameImageSchema,
  gameStatusSchema,
  gameVideoSchema,
  officialLinkSchema as dbOfficialLinkSchema,
  taxonomySchema,
} from "../db/validation";

const canonicalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}, "Expected a real calendar date in YYYY-MM-DD format");

const steamExternalIdSchema = z.strictObject({
  provider: z.literal("steam"),
  externalId: externalIdSchema.shape.externalId,
  externalUrl: dbOfficialLinkSchema.shape.url,
});

const officialLinkSchema = z.strictObject({
  provider: z.literal("steam"),
  platform: z.null(),
  linkType: z.enum(["store", "official_website"]),
  url: dbOfficialLinkSchema.shape.url,
  isOfficial: z.boolean(),
  verificationStatus: z.enum(["verified", "unverified"]),
  verificationMethod: z.enum(["provider_api"]).nullable(),
});

const imageSchema = z.strictObject({
  type: gameImageSchema.shape.type.extract(["cover", "hero", "screenshot"]),
  sourceUrl: gameImageSchema.shape.sourceUrl,
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  sortOrder: z.number().int().nonnegative(),
});

const videoSchema = z.strictObject({
  provider: z.literal("steam"),
  externalId: gameVideoSchema.shape.externalId,
  title: z.string().trim().max(500).nullable(),
  thumbnailUrl: dbOfficialLinkSchema.shape.url.nullable(),
  sortOrder: z.number().int().nonnegative(),
});

export const canonicalCandidateSchema = z.strictObject({
  source: z.strictObject({
    provider: z.literal("steam"),
    externalId: externalIdSchema.shape.externalId,
    fetchedAt: z.date(),
  }),
  game: z.strictObject({
    preferredSlug: createGameSchema.shape.slug,
    title: createGameSchema.shape.title,
    summary: z.string().trim().max(1000).nullable(),
    description: z.null(),
    status: gameStatusSchema.extract(["upcoming", "released"]),
    releaseDate: canonicalDateSchema.nullable(),
    coverUrl: dbOfficialLinkSchema.shape.url.nullable(),
    heroUrl: dbOfficialLinkSchema.shape.url.nullable(),
  }),
  externalIds: z.array(steamExternalIdSchema).length(1),
  officialLinks: z.array(officialLinkSchema),
  genres: z.array(taxonomySchema),
  platforms: z.array(z.strictObject({
    slug: z.enum(["windows", "macos", "linux"]),
    name: z.string().trim().min(1).max(160),
  })),
  companies: z.array(z.strictObject({
    preferredSlug: createGameSchema.shape.slug,
    name: z.string().trim().min(1).max(160),
    role: z.enum(["developer", "publisher"]),
  })),
  images: z.array(imageSchema),
  videos: z.array(videoSchema).max(20),
}).superRefine((candidate, context) => {
  const externalIdKeys = new Set<string>();
  candidate.externalIds.forEach((externalId, index) => {
    const key = `${externalId.provider}:${externalId.externalId}`;
    if (externalIdKeys.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Candidate external IDs must be unique",
        path: ["externalIds", index],
      });
    }
    externalIdKeys.add(key);
  });

  const sourceExternalIds = candidate.externalIds.filter((externalId) => (
    externalId.provider === "steam" && externalId.externalId === candidate.source.externalId
  ));
  if (sourceExternalIds.length !== 1) {
    context.addIssue({
      code: "custom",
      message: "Candidate must include exactly one Steam external ID matching its source App ID",
      path: ["externalIds"],
    });
  }

  const canonicalStoreUrl = `https://store.steampowered.com/app/${candidate.source.externalId}/`;
  const storeLinks = candidate.officialLinks.filter((link) => link.linkType === "store");
  if (storeLinks.length !== 1 || storeLinks[0]?.url !== canonicalStoreUrl) {
    context.addIssue({
      code: "custom",
      message: "Candidate must include exactly one canonical Steam Store URL",
      path: ["officialLinks"],
    });
  }

  const screenshots = candidate.images.filter((image) => image.type === "screenshot");
  if (screenshots.length > 50) {
    context.addIssue({
      code: "too_big",
      maximum: 50,
      inclusive: true,
      origin: "array",
      message: "Candidate may include at most 50 screenshots",
      path: ["images"],
    });
  }
});

export type CanonicalGameCandidate = z.infer<typeof canonicalCandidateSchema>;

export const importWarningSchema = z.strictObject({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
});

export type ImportWarning = z.infer<typeof importWarningSchema>;

export const normalizationResultSchema = z.strictObject({
  candidate: canonicalCandidateSchema,
  warnings: z.array(importWarningSchema),
});

export type NormalizationResult = z.infer<typeof normalizationResultSchema>;

export type PlannedSkip = {
  field: string;
  reason: string;
  incoming: unknown;
  stored: unknown;
};

export type PlannedUpdate = {
  entity: "external_id" | "official_link" | "video";
  key: string;
  changes: Record<string, unknown>;
};

export type SteamImportPlan = {
  action: "create" | "existing" | "update";
  selectedSlug: string;
  existingGameId: number | null;
  candidate: CanonicalGameCandidate;
  resolvedCompanies: Array<{ slug: string; name: string; role: "developer" | "publisher" }>;
  creates: Array<{ entity: string; key: string }>;
  updates: PlannedUpdate[];
  skips: PlannedSkip[];
  warnings: ImportWarning[];
};

export type SteamImportResult = {
  status: "created" | "existing" | "updated";
  gameId: number | null;
  appId: string;
  dryRun: boolean;
  plan: SteamImportPlan;
};
