import type { AnyD1Database } from "drizzle-orm/d1";
import { createDatabase } from "../lib/db/client";
import { createGameRepository } from "../lib/db/repositories/games";

async function main() {
  process.env.WRANGLER_LOG_PATH = "/tmp/gamehub-wrangler-verify.log";
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<{ DB: AnyD1Database }>({
    configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
    persist: true,
    remoteBindings: false,
  });
  const repository = createGameRepository(createDatabase(platform.env.DB));
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let gameId: number | undefined;

  try {
    const game = await repository.create({
    slug: `v2-1-verification-${suffix}`,
    title: "GameHub V2.1 Verification",
    status: "announced",
  });
    gameId = game.id;
    await repository.addExternalId(game.id, { provider: "steam", externalId: `verify-${suffix}` });
    await repository.addOfficialLink(game.id, {
    provider: "gamehub",
    linkType: "official_website",
    url: `https://example.com/gamehub-verification/${suffix}`,
  });
    await repository.addImage(game.id, {
    type: "cover",
    sourceUrl: `https://example.com/gamehub-verification/${suffix}.jpg`,
  });
    await repository.addVideo(game.id, {
    provider: "youtube",
    externalId: `verify-${suffix}`,
  });

    const bySlug = await repository.findBySlug(game.slug);
    const byExternalId = await repository.findByExternalId("steam", `verify-${suffix}`);
    const updated = await repository.update(game.id, { status: "released" });
    const countsBeforeDelete = {
    externalIds: (await repository.listExternalIds(game.id)).length,
    officialLinks: (await repository.listOfficialLinks(game.id)).length,
    images: (await repository.listImages(game.id)).length,
    videos: (await repository.listVideos(game.id)).length,
  };

    if (!bySlug || byExternalId?.id !== game.id || updated?.status !== "released") {
      throw new Error("Local D1 read/update verification failed");
    }
    if (Object.values(countsBeforeDelete).some((count) => count !== 1)) {
      throw new Error("Local D1 relation verification failed");
    }

    await repository.delete(game.id);
    gameId = undefined;
    const cascadeCounts = {
    externalIds: (await repository.listExternalIds(game.id)).length,
    officialLinks: (await repository.listOfficialLinks(game.id)).length,
    images: (await repository.listImages(game.id)).length,
    videos: (await repository.listVideos(game.id)).length,
  };
    if (Object.values(cascadeCounts).some((count) => count !== 0)) {
      throw new Error("Local D1 cascade verification failed");
    }

    console.log(JSON.stringify({
      success: true,
      canonicalIdType: typeof game.id,
      countsBeforeDelete,
      cascadeCounts,
    }, null, 2));
  } finally {
    if (gameId) await repository.delete(gameId);
    await platform.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
