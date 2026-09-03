export type SteamSearchResult = {
  appId: string;
  name: string;
  type: "game" | "unknown";
  imageUrl: string | null;
};

export type SteamSearchWarningCode =
  | "invalid_image_url"
  | "duplicate_app_id"
  | "unsupported_store_item_type"
  | "result_limit_applied";

export type SteamSearchWarning = {
  code: SteamSearchWarningCode;
  message: string;
  itemIndex?: number;
  storeItemType?: string;
  appId?: string;
};

export type SteamSearchNormalizationResult = {
  results: SteamSearchResult[];
  warnings: SteamSearchWarning[];
};
