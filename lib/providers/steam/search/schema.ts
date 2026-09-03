import { z } from "zod";

export const steamSearchRawItemSchema = z.looseObject({
  id: z.number().int().min(1).max(4_294_967_295),
  name: z.string().trim().min(1),
  type: z.string().refine((value) => value.trim().length > 0),
  tiny_image: z.string().optional(),
});

export const steamSearchRawResponseSchema = z.looseObject({
  items: z.array(steamSearchRawItemSchema),
});

export type SteamSearchRawItem = z.infer<typeof steamSearchRawItemSchema>;
export type SteamSearchRawResponse = z.infer<typeof steamSearchRawResponseSchema>;
