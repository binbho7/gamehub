import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createD1TestBinding } from "../../../test/d1-test-env";
import { LinkVerificationError } from "../../verifiers/official-links/errors";
import type {
  GameLinkVerificationPlan,
  LinkVerificationPlanItem,
  LinkVerificationSnapshot,
  LinkVerificationUpdate,
} from "../../verifiers/official-links/types";
import { createDatabase, type GameHubDatabase } from "../client";
import * as schema from "../schema";
import {
  createLinkVerificationStore,
  type LinkVerificationStore,
} from "./link-verification";

const EXACT_WRITE_URL =
  "https://write-user:write-password@example.com/path?token=write-secret#fragment";
const SNAPSHOT_UPDATED_AT = new Date("2026-09-05T01:00:00.000Z");
const WRITE_VERIFIED_AT = new Date("2026-09-06T02:00:00.000Z");
const WRITE_CHECKED_AT = new Date("2026-09-06T02:00:01.000Z");
const WRITE_UPDATED_AT = new Date("2026-09-06T02:00:02.000Z");

function writableSnapshot(
  overrides: Partial<LinkVerificationSnapshot> = {},
): LinkVerificationSnapshot {
  return {
    id: 11,
    gameId: 7,
    url: EXACT_WRITE_URL,
    updatedAt: SNAPSHOT_UPDATED_AT,
    verificationStatus: "unverified",
    verificationMethod: null,
    httpStatus: null,
    redirectUrl: null,
    verifiedAt: null,
    lastCheckedAt: null,
    ...overrides,
  };
}

function writableChanges(
  overrides: Partial<LinkVerificationUpdate> = {},
): LinkVerificationUpdate {
  return {
    verificationStatus: "verified",
    verificationMethod: "http",
    httpStatus: 204,
    redirectUrl: "https://final.example.net/verified",
    verifiedAt: WRITE_VERIFIED_AT,
    lastCheckedAt: WRITE_CHECKED_AT,
    updatedAt: WRITE_UPDATED_AT,
    ...overrides,
  };
}

function updateItem(
  snapshot: LinkVerificationSnapshot,
  changes: LinkVerificationUpdate = writableChanges(),
): LinkVerificationPlanItem {
  return { action: "update", snapshot, changes };
}

function writePlan(items: LinkVerificationPlanItem[]): GameLinkVerificationPlan {
  return {
    gameId: 7,
    dryRun: false,
    linksRead: items.length,
    verificationResults: [],
    items,
  };
}

async function seedWritableGames(binding: AnyD1Database): Promise<void> {
  await binding.prepare(`
    INSERT INTO games (id, slug, title, created_at, updated_at)
    VALUES
      (7, 'write-game', 'Write Game', 1000, 1000),
      (8, 'other-game', 'Other Game', 1000, 1000)
  `).run();
}

async function seedWritableLink(
  binding: AnyD1Database,
  snapshot: LinkVerificationSnapshot,
): Promise<void> {
  await binding.prepare(`
    INSERT INTO game_official_links (
      id, game_id, provider, platform, link_type, url, region, is_official,
      verification_status, verification_method, http_status, redirect_url,
      verified_at, last_checked_at, created_at, updated_at
    ) VALUES (
      ?, ?, 'publisher', 'windows', 'official_website', ?, 'GB', 1,
      ?, ?, ?, ?, ?, ?, 1000, ?
    )
  `).bind(
    snapshot.id,
    snapshot.gameId,
    snapshot.url,
    snapshot.verificationStatus,
    snapshot.verificationMethod,
    snapshot.httpStatus,
    snapshot.redirectUrl,
    snapshot.verifiedAt?.getTime() ?? null,
    snapshot.lastCheckedAt?.getTime() ?? null,
    snapshot.updatedAt.getTime(),
  ).run();
}

async function storedLinks(binding: AnyD1Database): Promise<unknown[]> {
  const rows = await binding.prepare(`
    SELECT * FROM game_official_links ORDER BY id
  `).all();
  return rows.results;
}

type ConcurrentMutation = {
  name: string;
  snapshot?: Partial<LinkVerificationSnapshot>;
  mutate: (
    binding: AnyD1Database,
    snapshot: LinkVerificationSnapshot,
  ) => Promise<unknown>;
};

const concurrentMutations: ConcurrentMutation[] = [
  {
    name: "link ID",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET id = 12 WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
  {
    name: "game relationship",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET game_id = 8 WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
  {
    name: "exact URL",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET url = ? WHERE id = ?",
    ).bind(
      "https://raced.example.com/path?token=raced-secret",
      snapshot.id,
    ).run(),
  },
  {
    name: "updated time",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET updated_at = ? WHERE id = ?",
    ).bind(snapshot.updatedAt.getTime() + 1, snapshot.id).run(),
  },
  {
    name: "verification status",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET verification_status = 'pending' WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
  {
    name: "manual verification ownership",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET verification_method = 'manual' WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
  {
    name: "non-manual verification method",
    snapshot: { verificationMethod: "http" },
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET verification_method = 'provider_api' WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
  {
    name: "HTTP status",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET http_status = 201 WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
  {
    name: "redirect URL",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET redirect_url = ? WHERE id = ?",
    ).bind(
      "https://raced-redirect.example.com/?signature=raced-secret",
      snapshot.id,
    ).run(),
  },
  {
    name: "verified time",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET verified_at = 1234 WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
  {
    name: "checked time",
    mutate: (binding, snapshot) => binding.prepare(
      "UPDATE game_official_links SET last_checked_at = 2345 WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
  {
    name: "row deletion",
    mutate: (binding, snapshot) => binding.prepare(
      "DELETE FROM game_official_links WHERE id = ?",
    ).bind(snapshot.id).run(),
  },
];

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

    expect(Object.keys(store)).toEqual(["readGameLinks", "writePlan"]);
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

describe("link verification optimistic writes on local D1", () => {
  let binding: AnyD1Database;
  let store: LinkVerificationStore;
  let dispose: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const testEnv = await createD1TestBinding();
    binding = testEnv.binding;
    dispose = testEnv.dispose;
    store = createLinkVerificationStore(createDatabase(binding));
    await seedWritableGames(binding);
  });

  afterEach(async () => dispose?.());

  it("applies exactly the seven approved metadata values for a null-bearing current snapshot", async () => {
    const snapshot = writableSnapshot();
    const changes = writableChanges();
    await seedWritableLink(binding, snapshot);

    const queries: string[] = [];
    const observedBinding = new Proxy(binding, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            queries.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const observedStore = createLinkVerificationStore(drizzle(observedBinding, { schema }));

    await expect(observedStore.writePlan(writePlan([
      updateItem(snapshot, changes),
    ]))).resolves.toEqual({
      affectedRows: 1,
      appliedLinkIds: [11],
      conflicts: [],
    });

    const updateQueries = queries.filter((query) => (
      /^update\s+"game_official_links"\s+set\s+/i.test(query)
    ));
    expect(updateQueries).toHaveLength(1);
    const setClause = updateQueries[0]!.match(/\bset\s+(.+)\s+where\b/i)?.[1];
    expect(setClause).toBeDefined();
    expect([...(setClause ?? "").matchAll(/"([^"]+)"\s*=\s*\?/g)]
      .map((match) => match[1])).toEqual([
      "verification_status",
      "verification_method",
      "http_status",
      "redirect_url",
      "verified_at",
      "last_checked_at",
      "updated_at",
    ]);

    expect((await storedLinks(binding))[0]).toMatchObject({
      id: 11,
      game_id: 7,
      provider: "publisher",
      platform: "windows",
      link_type: "official_website",
      url: EXACT_WRITE_URL,
      region: "GB",
      is_official: 1,
      verification_status: changes.verificationStatus,
      verification_method: changes.verificationMethod,
      http_status: changes.httpStatus,
      redirect_url: changes.redirectUrl,
      verified_at: changes.verifiedAt?.getTime(),
      last_checked_at: changes.lastCheckedAt.getTime(),
      created_at: 1000,
      updated_at: changes.updatedAt.getTime(),
    });
  });

  it.each(concurrentMutations)(
    "reports a conflict and preserves the concurrently changed row after a $name race",
    async ({ snapshot: overrides, mutate }) => {
      const snapshot = writableSnapshot(overrides);
      await seedWritableLink(binding, snapshot);
      await mutate(binding, snapshot);
      const racedRows = await storedLinks(binding);

      await expect(store.writePlan(writePlan([
        updateItem(snapshot),
      ]))).resolves.toEqual({
        affectedRows: 0,
        appliedLinkIds: [],
        conflicts: [{ linkId: 11, code: "write_conflict" }],
      });
      expect(await storedLinks(binding)).toEqual(racedRows);
    },
  );

  it("commits a current sibling while reporting a stale sibling as a per-link conflict", async () => {
    const current = writableSnapshot({ id: 11 });
    const stale = writableSnapshot({
      id: 12,
      url: "https://stale.example.com/?api_key=stale-secret",
      verificationMethod: "provider_api",
      httpStatus: 200,
      redirectUrl: "https://old.example.com/final",
      verifiedAt: new Date("2026-09-04T00:00:00.000Z"),
      lastCheckedAt: new Date("2026-09-05T00:00:00.000Z"),
    });
    await seedWritableLink(binding, current);
    await seedWritableLink(binding, stale);
    await binding.prepare(`
      UPDATE game_official_links
      SET verification_status = 'pending'
      WHERE id = 12
    `).run();

    const outcome = await store.writePlan(writePlan([
      updateItem(current),
      updateItem(stale, writableChanges({
        verificationStatus: "broken",
        httpStatus: 404,
        redirectUrl: null,
        verifiedAt: stale.verifiedAt,
      })),
    ]));

    expect(outcome).toEqual({
      affectedRows: 1,
      appliedLinkIds: [11],
      conflicts: [{ linkId: 12, code: "write_conflict" }],
    });
    const rows = await storedLinks(binding);
    expect(rows[0]).toMatchObject({
      id: 11,
      verification_status: "verified",
      verification_method: "http",
      http_status: 204,
      updated_at: WRITE_UPDATED_AT.getTime(),
    });
    expect(rows[1]).toMatchObject({
      id: 12,
      verification_status: "pending",
      verification_method: "provider_api",
      http_status: 200,
      updated_at: SNAPSHOT_UPDATED_AT.getTime(),
    });
  });

  it("never writes explicit skip items", async () => {
    const manual = writableSnapshot({
      id: 11,
      verificationStatus: "verified",
      verificationMethod: "manual",
      httpStatus: 200,
    });
    const unchanged = writableSnapshot({
      id: 12,
      url: "https://unchanged.example.com/",
      verificationMethod: "http",
    });
    await seedWritableLink(binding, manual);
    await seedWritableLink(binding, unchanged);
    const before = await storedLinks(binding);

    await expect(store.writePlan(writePlan([
      {
        action: "skip",
        linkId: manual.id,
        originalUrl: manual.url,
        reason: "manual_verification_preserved",
      },
      {
        action: "skip",
        linkId: unchanged.id,
        originalUrl: unchanged.url,
        reason: "no_metadata_change",
      },
    ]))).resolves.toEqual({
      affectedRows: 0,
      appliedLinkIds: [],
      conflicts: [],
    });
    expect(await storedLinks(binding)).toEqual(before);
  });

  it("refuses a current snapshot that belongs to a different game than the plan", async () => {
    const otherGame = writableSnapshot({ gameId: 8 });
    await seedWritableLink(binding, otherGame);
    const before = await storedLinks(binding);

    await expect(store.writePlan(writePlan([
      updateItem(otherGame),
    ]))).resolves.toEqual({
      affectedRows: 0,
      appliedLinkIds: [],
      conflicts: [{ linkId: 11, code: "write_conflict" }],
    });
    expect(await storedLinks(binding)).toEqual(before);
  });

  it("refuses an update item whose current row is manually owned", async () => {
    const manual = writableSnapshot({
      verificationStatus: "verified",
      verificationMethod: "manual",
      httpStatus: 200,
      verifiedAt: new Date("2026-09-04T00:00:00.000Z"),
    });
    await seedWritableLink(binding, manual);
    const before = await storedLinks(binding);

    await expect(store.writePlan(writePlan([
      updateItem(manual, writableChanges({
        verificationStatus: "broken",
        httpStatus: 404,
        redirectUrl: null,
        verifiedAt: manual.verifiedAt,
      })),
    ]))).resolves.toEqual({
      affectedRows: 0,
      appliedLinkIds: [],
      conflicts: [{ linkId: 11, code: "write_conflict" }],
    });
    expect(await storedLinks(binding)).toEqual(before);
  });

  it("rolls back valid siblings and returns a sanitized write_failed error on SQL failure", async () => {
    const first = writableSnapshot({ id: 11 });
    const failing = writableSnapshot({
      id: 12,
      url: "https://failure.example.com/?secret=sql-failure-secret",
    });
    await seedWritableLink(binding, first);
    await seedWritableLink(binding, failing);
    const before = await storedLinks(binding);

    let caught: unknown;
    try {
      await store.writePlan(writePlan([
        updateItem(first),
        updateItem(failing, writableChanges({ httpStatus: 600 })),
      ]));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LinkVerificationError);
    expect(caught).toMatchObject({
      code: "write_failed",
      message: "Unable to write link verification data",
    });
    expect(JSON.stringify(caught)).not.toMatch(
      /sql-failure-secret|game_official_links|check constraint|update\s/i,
    );
    expect(await storedLinks(binding)).toEqual(before);
  });

  it("maps an impossible multi-row update result to a sanitized invariant failure", async () => {
    const database = createDatabase(binding);
    const overReportingDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async () => [{ meta: { changes: 2 } }];
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as GameHubDatabase;
    const overReportingStore = createLinkVerificationStore(overReportingDatabase);

    let caught: unknown;
    try {
      await overReportingStore.writePlan(writePlan([
        updateItem(writableSnapshot()),
      ]));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LinkVerificationError);
    expect(caught).toMatchObject({
      code: "write_failed",
      message: "Link verification write invariant violated",
    });
    expect(JSON.stringify(caught)).not.toContain("write-secret");
  });
});
