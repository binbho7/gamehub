import { z } from "zod";

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const canonicalIdStringSchema = z.string().regex(/^\d+$/).refine((value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}, "Expected a positive safe-integer identity");
const slugSchema = z.string().trim().min(1).max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a lowercase URL slug");
const nullableTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();
const canonicalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}, "Expected a real UTC calendar date");
const httpUrlSchema = z.string().trim().url().max(2048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Expected an HTTP(S) URL");

const igdbExternalIdCandidateSchema = z.strictObject({
  provider: z.literal("igdb"),
  externalId: canonicalIdStringSchema,
  externalUrl: z.null(),
});

const taxonomyCandidateSchema = z.strictObject({
  slug: slugSchema,
  name: z.string().trim().min(1).max(160),
});

const companyCandidateSchema = z.strictObject({
  preferredSlug: slugSchema,
  name: z.string().trim().min(1).max(160),
  websiteUrl: z.null(),
  role: z.enum(["developer", "publisher"]),
});

const officialLinkCandidateSchema = z.strictObject({
  provider: z.literal("igdb"),
  platform: z.null(),
  linkType: z.literal("official_website"),
  url: httpUrlSchema,
  isOfficial: z.literal(true),
  verificationStatus: z.literal("unverified"),
  verificationMethod: z.null(),
});

const imageCandidateSchema = z.strictObject({
  type: z.enum(["cover", "artwork", "screenshot"]),
  sourceUrl: httpUrlSchema,
  width: positiveSafeIntegerSchema.nullable(),
  height: positiveSafeIntegerSchema.nullable(),
  sortOrder: z.number().int().nonnegative().safe(),
});

const videoCandidateSchema = z.strictObject({
  provider: z.literal("igdb"),
  externalId: z.string().trim().min(1).max(255),
  title: nullableTextSchema(500),
  thumbnailUrl: httpUrlSchema.nullable(),
  sortOrder: z.number().int().nonnegative().safe(),
});

export const igdbEnrichmentCandidateSchema = z.strictObject({
  source: z.strictObject({
    provider: z.literal("igdb"),
    externalId: canonicalIdStringSchema,
    fetchedAt: z.date().refine((value) => !Number.isNaN(value.getTime()), "Expected a valid fetch date"),
  }),
  identity: z.strictObject({
    canonicalGameId: positiveSafeIntegerSchema,
    steamAppId: canonicalIdStringSchema,
    igdbGameId: canonicalIdStringSchema,
  }),
  game: z.strictObject({
    title: nullableTextSchema(300),
    summary: nullableTextSchema(1000),
    description: nullableTextSchema(100_000),
    releaseDate: canonicalDateSchema.nullable(),
    coverUrl: httpUrlSchema.nullable(),
    heroUrl: httpUrlSchema.nullable(),
  }),
  externalIds: z.array(igdbExternalIdCandidateSchema).length(1),
  genres: z.array(taxonomyCandidateSchema),
  platforms: z.array(taxonomyCandidateSchema),
  companies: z.array(companyCandidateSchema),
  officialLinks: z.array(officialLinkCandidateSchema),
  images: z.array(imageCandidateSchema),
  videos: z.array(videoCandidateSchema).max(20),
}).superRefine((candidate, context) => {
  if (
    candidate.source.externalId !== candidate.identity.igdbGameId
    || candidate.externalIds[0]?.externalId !== candidate.identity.igdbGameId
  ) {
    context.addIssue({
      code: "custom",
      message: "Candidate IGDB identities must agree",
      path: ["identity", "igdbGameId"],
    });
  }

  const coverCount = candidate.images.filter((image) => image.type === "cover").length;
  const artworkCount = candidate.images.filter((image) => image.type === "artwork").length;
  const screenshotCount = candidate.images.filter((image) => image.type === "screenshot").length;
  ([
    [coverCount, 1, "cover"],
    [artworkCount, 20, "artwork"],
    [screenshotCount, 50, "screenshot"],
  ] as const).forEach(([count, maximum, kind]) => {
    if (count > maximum) {
      context.addIssue({
        code: "too_big",
        origin: "array",
        maximum,
        inclusive: true,
        message: `Candidate exceeds the ${kind} media limit`,
        path: ["images"],
      });
    }
  });

  const imageUrls = new Set<string>();
  candidate.images.forEach((image, index) => {
    if (imageUrls.has(image.sourceUrl)) {
      context.addIssue({
        code: "custom",
        message: "Candidate image URLs must be unique",
        path: ["images", index, "sourceUrl"],
      });
    }
    imageUrls.add(image.sourceUrl);
  });

  const videoIds = new Set<string>();
  candidate.videos.forEach((video, index) => {
    if (videoIds.has(video.externalId)) {
      context.addIssue({
        code: "custom",
        message: "Candidate video IDs must be unique",
        path: ["videos", index, "externalId"],
      });
    }
    videoIds.add(video.externalId);
  });
});

export type IgdbEnrichmentCandidate = z.infer<typeof igdbEnrichmentCandidateSchema>;

export const igdbEnrichmentWarningSchema = z.strictObject({
  code: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(500),
  path: z.string().trim().min(1).max(500).optional(),
});

export type IgdbEnrichmentWarning = z.infer<typeof igdbEnrichmentWarningSchema>;

export const igdbNormalizationResultSchema = z.strictObject({
  candidate: igdbEnrichmentCandidateSchema,
  warnings: z.array(igdbEnrichmentWarningSchema),
});

export type IgdbNormalizationResult = z.infer<typeof igdbNormalizationResultSchema>;

export type PlannedCreate = {
  entity: string;
  key: string;
  values: Record<string, unknown>;
};

export type PlannedUpdate = {
  entity: string;
  key: string;
  changes: Record<string, unknown>;
};

export type PlannedSkip = {
  field: string;
  reason: string;
  incoming: unknown;
  stored: unknown;
};

export type EnrichmentConflict = {
  code: string;
  field: string;
  message: string;
  incoming?: unknown;
  stored?: unknown;
};

export type IgdbEnrichmentPlan = {
  action: "enrich" | "existing" | "blocked";
  gameId: number;
  slug: string;
  matchedIgdbGame: { id: string; name: string } | null;
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  skips: PlannedSkip[];
  warnings: IgdbEnrichmentWarning[];
  conflicts: EnrichmentConflict[];
};

export type IgdbEnrichmentResult = {
  status: IgdbEnrichmentPlan["action"];
  gameId: number;
  dryRun: boolean;
  affectedRows: number;
  plan: IgdbEnrichmentPlan;
};
