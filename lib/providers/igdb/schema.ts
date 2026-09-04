import { z } from "zod";

const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonEmptyStringSchema = z.string().trim().min(1);

export const igdbNamedEntitySchema = z.looseObject({
  id: positiveSafeIntegerSchema,
  name: nonEmptyStringSchema,
  slug: nonEmptyStringSchema,
});

export const igdbCompanySchema = z.looseObject({
  id: positiveSafeIntegerSchema,
  name: nonEmptyStringSchema,
  slug: nonEmptyStringSchema,
});

export const igdbInvolvedCompanySchema = z.looseObject({
  developer: z.boolean(),
  publisher: z.boolean(),
  company: igdbCompanySchema,
});

export const igdbImageSchema = z.looseObject({
  image_id: nonEmptyStringSchema,
  width: positiveSafeIntegerSchema,
  height: positiveSafeIntegerSchema,
});

export const igdbVideoSchema = z.looseObject({
  video_id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
});

export const igdbWebsiteSchema = z.looseObject({
  type: positiveSafeIntegerSchema,
  trusted: z.boolean(),
  url: nonEmptyStringSchema,
});

export const igdbExternalGamesResponseSchema = z.array(z.looseObject({
  id: positiveSafeIntegerSchema,
  game: positiveSafeIntegerSchema,
  uid: nonEmptyStringSchema,
  external_game_source: positiveSafeIntegerSchema,
}));

export const igdbGamesResponseSchema = z.array(z.looseObject({
  id: positiveSafeIntegerSchema,
  name: nonEmptyStringSchema,
  summary: z.string().nullable().optional(),
  storyline: z.string().nullable().optional(),
  first_release_date: z.number().int().safe().nullable().optional(),
  genres: z.array(z.unknown()).optional(),
  platforms: z.array(z.unknown()).optional(),
  involved_companies: z.array(z.unknown()).optional(),
  cover: z.unknown().nullable().optional(),
  artworks: z.array(z.unknown()).optional(),
  screenshots: z.array(z.unknown()).optional(),
  videos: z.array(z.unknown()).optional(),
  websites: z.array(z.unknown()).optional(),
}));

export type IgdbNamedEntityRaw = z.infer<typeof igdbNamedEntitySchema>;
export type IgdbCompanyRaw = z.infer<typeof igdbCompanySchema>;
export type IgdbInvolvedCompanyRaw = z.infer<typeof igdbInvolvedCompanySchema>;
export type IgdbImageRaw = z.infer<typeof igdbImageSchema>;
export type IgdbVideoRaw = z.infer<typeof igdbVideoSchema>;
export type IgdbWebsiteRaw = z.infer<typeof igdbWebsiteSchema>;
export type IgdbExternalGameRaw = z.infer<typeof igdbExternalGamesResponseSchema>[number];
export type IgdbGameRaw = z.infer<typeof igdbGamesResponseSchema>[number];
