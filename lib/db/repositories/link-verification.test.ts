import type { AnyD1Database } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD1TestBinding } from "../../../test/d1-test-env";
import { LinkVerificationError } from "../../verifiers/official-links/errors";
import { createDatabase, type GameHubDatabase } from "../client";
import {
  createLinkVerificationStore,
  type LinkVerificationStore,
} from "./link-verification";

describe("link verification read store on D1", () => {
  let binding: AnyD1Database;
  let store: LinkVerificationStore;
  let dispose: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const testEnv = await createD1TestBinding();
    binding = testEnv.binding;
    dispose = testEnv.dispose;
    store = createLinkVerificationStore(createDatabase(binding));
  });

  afterEach(async () => dispose?.());

  it("distinguishes a missing game from an existing game with zero links", async () => {
    await binding.prepare(`
      INSERT INTO games (id, slug, title, created_at, updated_at)
      VALUES (7, 'empty-links', 'Empty Links', 1000, 1000)
    `).run();

    expect(Object.keys(store)).toEqual(["readGameLinks"]);
    await expect(store.readGameLinks(404)).resolves.toEqual({
      gameExists: false,
      links: [],
    });
    await expect(store.readGameLinks(7)).resolves.toEqual({
      gameExists: true,
      links: [],
    });
  });

  it("loads every compare-before-update field in stable link ID order without writing", async () => {
    const exactUrl =
      "https://read-user:read-password@example.com/path?token=read-secret#fragment";
    await binding.prepare(`
      INSERT INTO games (id, slug, title, created_at, updated_at)
      VALUES (7, 'snapshot-game', 'Snapshot Game', 1000, 1000)
    `).run();
    await binding.prepare(`
      INSERT INTO game_official_links (
        id, game_id, provider, platform, link_type, url, region, is_official,
        verification_status, verification_method, http_status, redirect_url,
        verified_at, last_checked_at, created_at, updated_at
      ) VALUES (
        20, 7, 'publisher', NULL, 'official_website',
        'https://second.example.com', NULL, 1,
        'unverified', NULL, NULL, NULL, NULL, NULL, 1100, 1200
      )
    `).run();
    await binding.prepare(`
      INSERT INTO game_official_links (
        id, game_id, provider, platform, link_type, url, region, is_official,
        verification_status, verification_method, http_status, redirect_url,
        verified_at, last_checked_at, created_at, updated_at
      ) VALUES (
        10, 7, 'steam', 'windows', 'store', ?, 'US', 1,
        'verified', 'provider_api', 204, 'https://redirect.example.com/final',
        1300, 1400, 1000, 1500
      )
    `).bind(exactUrl).run();
    const before = await binding.prepare(
      "SELECT * FROM game_official_links ORDER BY id",
    ).all();

    const read = await store.readGameLinks(7);

    expect(read).toEqual({
      gameExists: true,
      links: [
        {
          id: 10,
          gameId: 7,
          url: exactUrl,
          updatedAt: new Date(1500),
          verificationStatus: "verified",
          verificationMethod: "provider_api",
          httpStatus: 204,
          redirectUrl: "https://redirect.example.com/final",
          verifiedAt: new Date(1300),
          lastCheckedAt: new Date(1400),
        },
        {
          id: 20,
          gameId: 7,
          url: "https://second.example.com",
          updatedAt: new Date(1200),
          verificationStatus: "unverified",
          verificationMethod: null,
          httpStatus: null,
          redirectUrl: null,
          verifiedAt: null,
          lastCheckedAt: null,
        },
      ],
    });
    expect(await binding.prepare(
      "SELECT * FROM game_official_links ORDER BY id",
    ).all()).toEqual(before);
  });

  it("returns all 21 snapshots because the service owns the pre-network link limit", async () => {
    await binding.prepare(`
      INSERT INTO games (id, slug, title, created_at, updated_at)
      VALUES (7, 'limit-owner', 'Limit Owner', 1000, 1000)
    `).run();
    for (let id = 21; id >= 1; id -= 1) {
      await binding.prepare(`
        INSERT INTO game_official_links (
          id, game_id, provider, link_type, url, created_at, updated_at
        ) VALUES (?, 7, 'publisher', 'official_website', ?, 1000, 1000)
      `).bind(id, `https://link-${id}.example.com`).run();
    }

    const read = await store.readGameLinks(7);

    expect(read.links).toHaveLength(21);
    expect(read.links.map((link) => link.id)).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );
  });

  it("wraps raw D1 read failures in a sanitized operation error", async () => {
    const secret = "SELECT raw_sql_with_secret_token";
    const failingDatabase = {
      select() {
        throw new Error(secret);
      },
    } as unknown as GameHubDatabase;
    const failingStore = createLinkVerificationStore(failingDatabase);

    let caught: unknown;
    try {
      await failingStore.readGameLinks(7);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LinkVerificationError);
    expect(caught).toMatchObject({
      code: "database_unavailable",
      message: "Unable to read link verification data",
    });
    expect(JSON.stringify(caught)).not.toContain(secret);
  });
});
