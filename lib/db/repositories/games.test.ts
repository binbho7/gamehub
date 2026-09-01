import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD1TestBinding } from "../../../test/d1-test-env";
import { createDatabase } from "../client";
import { createGameRepository, type GameRepository } from "./games";

describe("game repository on D1", () => {
  let repository: GameRepository;
  let dispose: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const testEnv = await createD1TestBinding();
    dispose = testEnv.dispose;
    repository = createGameRepository(createDatabase(testEnv.binding));
  });

  afterEach(async () => dispose?.());

  it("performs canonical CRUD and bounded keyset queries", async () => {
    const first = await repository.create({
      slug: "black-myth-wukong",
      title: "Black Myth: Wukong",
      status: "released",
      releaseDate: "2024-08-20",
    });
    const second = await repository.create({ slug: "elden-ring", title: "Elden Ring" });

    expect(first.id).toBeTypeOf("number");
    expect(await repository.findById(first.id)).toMatchObject({ slug: "black-myth-wukong" });
    expect(await repository.findBySlug("elden-ring")).toMatchObject({ id: second.id });
    expect((await repository.list({ limit: 1 })).items.map((game) => game.id)).toEqual([first.id]);
    expect((await repository.list({ limit: 2, afterId: first.id })).items.map((game) => game.id)).toEqual([second.id]);

    const updated = await repository.update(first.id, { title: "Black Myth: Wukong Updated" });
    expect(updated?.title).toBe("Black Myth: Wukong Updated");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(await repository.delete(second.id)).toBe(true);
    expect(await repository.findById(second.id)).toBeNull();
  });

  it("maps provider IDs with only provider and external ID globally unique", async () => {
    const game = await repository.create({ slug: "provider-map", title: "Provider Map" });
    await repository.addExternalId(game.id, { provider: "Steam", externalId: "100" });
    await repository.addExternalId(game.id, { provider: "steam", externalId: "101" });

    expect(await repository.findByExternalId("STEAM", "101")).toMatchObject({ id: game.id });
    expect(await repository.listExternalIds(game.id)).toHaveLength(2);

    const other = await repository.create({ slug: "provider-map-other", title: "Other" });
    await expect(repository.addExternalId(other.id, { provider: "steam", externalId: "100" }))
      .rejects.toThrow();
  });

  it("scopes official URL uniqueness to each game", async () => {
    const first = await repository.create({ slug: "shared-link-a", title: "Shared A" });
    const second = await repository.create({ slug: "shared-link-b", title: "Shared B" });
    const link = { provider: "publisher", linkType: "official_website" as const, url: "https://example.com/game" };

    await repository.addOfficialLink(first.id, link);
    await repository.addOfficialLink(second.id, link);
    await expect(repository.addOfficialLink(first.id, link)).rejects.toThrow();
  });

  it("orders media and cascades child deletion", async () => {
    const game = await repository.create({ slug: "media-game", title: "Media Game" });
    await repository.addExternalId(game.id, { provider: "igdb", externalId: "900" });
    await repository.addImage(game.id, { type: "screenshot", sourceUrl: "https://example.com/b.jpg", sortOrder: 2 });
    await repository.addImage(game.id, { type: "cover", sourceUrl: "https://example.com/a.jpg", sortOrder: 0 });
    await repository.addVideo(game.id, { provider: "youtube", externalId: "b", sortOrder: 2 });
    await repository.addVideo(game.id, { provider: "youtube", externalId: "a", sortOrder: 0 });

    expect((await repository.listImages(game.id)).map((image) => image.sortOrder)).toEqual([0, 2]);
    expect((await repository.listVideos(game.id)).map((video) => video.sortOrder)).toEqual([0, 2]);

    await repository.delete(game.id);
    expect(await repository.listExternalIds(game.id)).toEqual([]);
    expect(await repository.listImages(game.id)).toEqual([]);
    expect(await repository.listVideos(game.id)).toEqual([]);
  });
});
