import type {
  SteamSearchNormalizationResult,
  SteamSearchWarning,
} from "./contracts";
import type { SteamSearchRawResponse } from "./schema";

function normalizeImageUrl(tinyImage: string): string | null {
  try {
    const parsed = new URL(tinyImage);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function normalizeSteamSearch(
  response: SteamSearchRawResponse,
  limit: number,
): SteamSearchNormalizationResult {
  const results: SteamSearchNormalizationResult["results"] = [];
  const warnings: SteamSearchWarning[] = [];
  const seenAppIds = new Set<string>();

  response.items.forEach((item, itemIndex) => {
    if (item.type !== "app") {
      warnings.push({
        code: "unsupported_store_item_type",
        message: `Ignored Steam Store item type: ${item.type}`,
        itemIndex,
        storeItemType: item.type,
      });
      return;
    }

    const appId = String(item.id);
    if (seenAppIds.has(appId)) {
      warnings.push({
        code: "duplicate_app_id",
        message: `Ignored duplicate App ID: ${appId}`,
        itemIndex,
        appId,
      });
      return;
    }
    seenAppIds.add(appId);

    let imageUrl: string | null = null;
    if (item.tiny_image !== undefined && item.tiny_image.length > 0) {
      imageUrl = normalizeImageUrl(item.tiny_image);
      if (imageUrl === null) {
        warnings.push({
          code: "invalid_image_url",
          message: `Ignored invalid image URL for App ID: ${appId}`,
          itemIndex,
          appId,
        });
      }
    }

    results.push({ appId, name: item.name.trim(), type: "unknown", imageUrl });
  });

  if (results.length > limit) {
    warnings.push({
      code: "result_limit_applied",
      message: `Limited ${results.length} results to ${limit}`,
    });
  }

  return { results: results.slice(0, limit), warnings };
}
