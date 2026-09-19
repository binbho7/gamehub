import { z } from "zod";

export const SITE_DATA_VERSION = 1 as const;
export const PUBLICATION_POLICY_VERSION = 1 as const;
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_PUBLISHED_GAMES = 10_000;

const releaseStatusSchema = z.enum(["released", "upcoming"]);

export const PublishedOfficialLinkSchema = z.object({
  provider: z.string().min(1),
  type: z.string().min(1),
  url: z.string().url(),
}).strict();

export type PublishedOfficialLink = z.infer<typeof PublishedOfficialLinkSchema>;

export const PublishedVideoSchema = z.object({
  provider: z.literal("youtube"),
  id: z.string().min(1),
  title: z.string().nullable(),
}).strict();

export type PublishedVideo = z.infer<typeof PublishedVideoSchema>;

const requirementSetSchema = z.object({
  os: z.string(),
  cpu: z.string(),
  ram: z.string(),
  gpu: z.string(),
  directX: z.string(),
  storage: z.string(),
}).strict();

const systemRequirementsSchema = z.object({
  minimum: requirementSetSchema,
  recommended: requirementSetSchema,
}).strict();

export type PublishedSystemRequirements = z.infer<typeof systemRequirementsSchema>;

export const UnavailableFieldsSchema = z.object({
  titleCn: z.null(),
  rating: z.null(),
  systemRequirements: systemRequirementsSchema.nullable(),
  modes: z.array(z.string()).nullable(),
  controllerSupport: z.boolean().nullable(),
  isFree: z.boolean().nullable(),
}).strict();

export type UnavailableFields = z.infer<typeof UnavailableFieldsSchema>;

export const PublishedGameSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  releaseDate: z.string().min(1),
  status: releaseStatusSchema,
  developer: z.string().min(1),
  publisher: z.string().min(1),
  genres: z.array(z.string().min(1)),
  platforms: z.array(z.string().min(1)),
  cover: z.string().url(),
  hero: z.string().url(),
  screenshots: z.array(z.string().url()),
  officialLinks: z.array(PublishedOfficialLinkSchema).min(1),
  genreSlugs: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1),
  platformSlugs: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).min(1),
  videos: z.array(PublishedVideoSchema),
  optional: UnavailableFieldsSchema,
}).strict();

export type PublishedGame = z.infer<typeof PublishedGameSchema>;

export const PublishedArtifactSchema = z.object({
  version: z.number().int(),
  snapshotDate: z.string().min(1),
  games: z.array(PublishedGameSchema),
}).strict();

export type PublishedArtifact = z.infer<typeof PublishedArtifactSchema>;

export const EligibilityDiagnosticSchema = z.object({
  slug: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

export type EligibilityDiagnostic = z.infer<typeof EligibilityDiagnosticSchema>;

// Lowercase aliases keep the contracts convenient for callers while the
// PascalCase names remain the canonical public API.
export const publishedOfficialLinkSchema = PublishedOfficialLinkSchema;
export const publishedVideoSchema = PublishedVideoSchema;
export const unavailableFieldsSchema = UnavailableFieldsSchema;
export const publishedGameSchema = PublishedGameSchema;
export const publishedArtifactSchema = PublishedArtifactSchema;
export const eligibilityDiagnosticSchema = EligibilityDiagnosticSchema;
