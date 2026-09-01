import { z } from "zod";

const slugSchema = z.string().trim().min(1).max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a lowercase URL slug");
const titleSchema = z.string().trim().min(1).max(300);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const httpUrlSchema = z.string().trim().url().max(2048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Expected an HTTP(S) URL");
const optionalUrl = httpUrlSchema.nullable().optional();
const providerSchema = z.string().trim().min(1).max(80)
  .transform((value) => value.toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/));
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}, "Expected a real calendar date in YYYY-MM-DD format");

export const gameStatusSchema = z.enum([
  "unknown",
  "announced",
  "upcoming",
  "early_access",
  "released",
  "cancelled",
  "delisted",
]);

export const createGameSchema = z.strictObject({
  slug: slugSchema,
  title: titleSchema,
  summary: optionalText(1000),
  description: optionalText(100_000),
  status: gameStatusSchema.optional(),
  releaseDate: dateSchema.nullable().optional(),
  coverUrl: optionalUrl,
  heroUrl: optionalUrl,
});

export const updateGameSchema = createGameSchema.partial().strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field must be updated",
);

export const externalIdSchema = z.strictObject({
  provider: providerSchema,
  externalId: z.string().trim().min(1).max(255),
  externalUrl: optionalUrl,
});

export const officialLinkSchema = z.strictObject({
  provider: providerSchema,
  platform: optionalText(80),
  linkType: z.enum(["official_website", "store", "purchase", "download", "demo", "launcher"]),
  url: httpUrlSchema,
  region: optionalText(16),
  isOfficial: z.boolean().optional(),
  verificationStatus: z.enum(["unverified", "pending", "verified", "failed"]).optional(),
  verificationMethod: z.enum(["manual", "http", "provider_api"]).nullable().optional(),
  httpStatus: z.number().int().min(100).max(599).nullable().optional(),
  redirectUrl: optionalUrl,
  verifiedAt: z.coerce.date().nullable().optional(),
  lastCheckedAt: z.coerce.date().nullable().optional(),
});

export const taxonomySchema = z.strictObject({
  slug: slugSchema,
  name: z.string().trim().min(1).max(160),
});

export const companySchema = taxonomySchema.extend({
  websiteUrl: optionalUrl,
}).strict();

export const genreRelationSchema = z.strictObject({ genreId: z.number().int().positive() });
export const platformRelationSchema = z.strictObject({ platformId: z.number().int().positive() });
export const companyRelationSchema = z.strictObject({
  companyId: z.number().int().positive(),
  role: z.enum(["developer", "publisher", "porting", "support"]),
});

export const gameImageSchema = z.strictObject({
  type: z.enum(["cover", "hero", "screenshot", "artwork", "logo"]),
  sourceUrl: httpUrlSchema,
  storageUrl: optionalUrl,
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});

export const gameVideoSchema = z.strictObject({
  provider: providerSchema,
  externalId: z.string().trim().min(1).max(255),
  title: optionalText(500),
  thumbnailUrl: optionalUrl,
  sortOrder: z.number().int().nonnegative().optional(),
});

export const gameListSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(24),
  afterId: z.number().int().positive().optional(),
  status: gameStatusSchema.optional(),
});

export type CreateGameInput = z.input<typeof createGameSchema>;
export type UpdateGameInput = z.input<typeof updateGameSchema>;
export type ExternalIdInput = z.input<typeof externalIdSchema>;
export type OfficialLinkInput = z.input<typeof officialLinkSchema>;
export type GameImageInput = z.input<typeof gameImageSchema>;
export type GameVideoInput = z.input<typeof gameVideoSchema>;
export type GameListInput = z.input<typeof gameListSchema>;
