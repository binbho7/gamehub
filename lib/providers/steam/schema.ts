import { z } from "zod";

const steamPlatformsSchema = z.looseObject({
  windows: z.boolean(),
  mac: z.boolean(),
  linux: z.boolean(),
});

const steamGenreSchema = z.looseObject({
  id: z.string(),
  description: z.string(),
});

const steamReleaseDateSchema = z.looseObject({
  coming_soon: z.boolean(),
  date: z.string(),
});

const steamScreenshotSchema = z.looseObject({
  id: z.number().int(),
  path_thumbnail: z.string(),
  path_full: z.string(),
});

const steamMovieSourcesSchema = z.looseObject({
  "480": z.string().optional(),
  max: z.string().optional(),
});

const steamMovieSchema = z.looseObject({
  id: z.number().int(),
  name: z.string().optional(),
  thumbnail: z.string().optional(),
  webm: steamMovieSourcesSchema.optional(),
  mp4: steamMovieSourcesSchema.optional(),
});

export const steamAppDetailsSchema = z.looseObject({
  type: z.string(),
  steam_appid: z.number().int().positive(),
  name: z.string().trim().min(1),
  short_description: z.string().optional(),
  detailed_description: z.string().optional(),
  website: z.string().nullable().optional(),
  developers: z.array(z.string()).optional(),
  publishers: z.array(z.string()).optional(),
  platforms: steamPlatformsSchema.optional(),
  genres: z.array(steamGenreSchema).optional(),
  release_date: steamReleaseDateSchema.optional(),
  header_image: z.string().optional(),
  capsule_image: z.string().optional(),
  screenshots: z.array(steamScreenshotSchema).optional(),
  movies: z.array(steamMovieSchema).optional(),
});

export const steamEnvelopeSchema = z.discriminatedUnion("success", [
  z.looseObject({
    success: z.literal(true),
    data: steamAppDetailsSchema,
  }),
  z.looseObject({
    success: z.literal(false),
    data: z.unknown().optional(),
  }),
]);

export const steamAppDetailsBodySchema = z.record(z.string(), steamEnvelopeSchema);

export type SteamAppDetails = z.infer<typeof steamAppDetailsSchema>;
export type SteamAppDetailsEnvelope = z.infer<typeof steamEnvelopeSchema>;
export type SteamAppDetailsBody = z.infer<typeof steamAppDetailsBodySchema>;
