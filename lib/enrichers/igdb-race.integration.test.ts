import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createD1TestBinding } from "../../test/d1-test-env";
import { createDatabase } from "../db/client";
import { createIgdbEnrichmentStore, type IgdbEnrichmentStore } from "../db/repositories/igdb-enrichment";
import { companies, gameExternalIds, games, genres, platforms } from "../db/schema";
import type { IgdbClient } from "../providers/igdb/client";
import { IgdbError } from "../providers/igdb/errors";
import { createIgdbEnricher } from "./igdb";
import { planIgdbEnrichment } from "./igdb-plan";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()!(); });
const providerTime = new Date("2026-09-22T00:00:00Z");
function client(gameId: number, kind: string = "genre"): IgdbClient {
  const steamId = gameId === 1 ? "1245620" : "1091500";
  const igdbId = gameId === 1 ? 119133 : 1877;
  return { async request(endpoint, query) {
    if (endpoint === "external_games") return { fetchedAt: providerTime, body: query.includes("game !=") ? [] : [{ id: gameId, game: igdbId, uid: steamId, external_game_source: 1 }] };
    return { fetchedAt: providerTime, body: [{ id: igdbId, name: gameId === 1 ? "ELDEN RING" : "Cyberpunk 2077",
      ...(["genre","genre-company"].includes(kind) ? { genres: [{ id: 12, name: "Role-playing (RPG)", slug: "role-playing-rpg" }] } : {}),
      ...(kind === "platform" ? { platforms: [{ id: 6, name: "PC (Microsoft Windows)", slug: "win" }] } : {}),
      ...(["company","genre-company"].includes(kind) ? { involved_companies: [{ developer: true, publisher: false, company: { id: 1, name: "FromSoftware", slug: "fromsoftware" } }] } : {}),
    }] };
  } };
}
async function setup() {
  const fixture = await createD1TestBinding(); disposers.push(fixture.dispose);
  const db = createDatabase(fixture.binding);
  await db.insert(games).values([{ id: 1, slug: "elden-ring", title: "ELDEN RING" }, { id: 2, slug: "cyberpunk-2077", title: "Cyberpunk 2077" }]);
  await db.insert(gameExternalIds).values([{ gameId: 1, provider: "steam", externalId: "1245620" }, { gameId: 2, provider: "steam", externalId: "1091500" }]);
  return { db, store: createIgdbEnrichmentStore(db) };
}

describe("IGDB compatible shared-entity write races", () => {
  it.each(["genre", "platform", "company"])("replans a concurrent %s winner and preserves both games' associations", async (kind) => {
    const { db, store } = await setup();
    let ready = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const outcomes = await Promise.all([1, 2].map(gameId => createIgdbEnricher({ client: client(gameId, kind), store,
      async planEnrichment(...args) {
        const plan = await planIgdbEnrichment(...args);
        if (ready < 2) { ready++; if (ready === 2) release(); await barrier; }
        return plan;
      },
    }).enrichGame(gameId, { dryRun: false })));
    expect(outcomes.map(o => o.status)).toEqual(["enrich", "enrich"]);
    expect(await db.select().from(kind === "genre" ? genres : kind === "platform" ? platforms : companies)).toHaveLength(1);
    for (const id of [1, 2]) {
      const snapshot = await store.findSnapshotByGameId(id);
      expect(snapshot?.[kind === "genre" ? "genres" : kind === "platform" ? "platforms" : "companies"]).toHaveLength(1);
      expect(snapshot?.externalIds.filter(x => x.provider === "igdb")).toHaveLength(1);
    }
  });

  it.each(["genre", "platform", "company"])("does not hide an incompatible concurrent %s winner", async (kind) => {
    const { db, store } = await setup(); let applies = 0;
    const wrapped: IgdbEnrichmentStore = { ...store, async applyPlan(plan) {
      applies++;
      if (applies === 1) {
        if (kind === "genre") await db.insert(genres).values({slug:"role-playing-rpg",name:"Incompatible"});
        if (kind === "platform") await db.insert(platforms).values({slug:"windows",name:"Incompatible"});
        if (kind === "company") await db.insert(companies).values({slug:"fromsoftware",name:"Incompatible"});
      }
      return store.applyPlan(plan);
    } };
    await expect(createIgdbEnricher({client:client(1,kind),store:wrapped}).enrichGame(1,{dryRun:false})).rejects.toMatchObject({code:"write_conflict"});
    expect(applies).toBe(1);
    expect(await db.select().from(gameExternalIds).where(eq(gameExternalIds.provider,"igdb"))).toHaveLength(0);
  });

  it("does not recover an IGDB identity owned by another canonical game", async () => {
    const { db, store } = await setup();
    await db.insert(gameExternalIds).values({gameId:2,provider:"igdb",externalId:"119133"});
    const result = await createIgdbEnricher({client:client(1),store}).enrichGame(1,{dryRun:false});
    expect(result.status).toBe("blocked");
    expect(result.plan.conflicts.map(c=>c.code)).toContain("identity_conflict");
    expect(await db.select().from(genres)).toHaveLength(0);
  });

  it("does not recover unknown write conflicts", async () => {
    const { store } = await setup(); let applies=0;
    await expect(createIgdbEnricher({client:client(1),store:{...store,async applyPlan(){applies++;throw new IgdbError("write_conflict","sanitized",{retryable:false});}}}).enrichGame(1,{dryRun:false})).rejects.toMatchObject({code:"write_conflict"});
    expect(applies).toBe(1);
  });

  it("stops after three internal apply attempts under successive compatible winners", async () => {
    const { db, store } = await setup(); let applies = 0;
    const provider = client(1);
    const incoming = [
      {id:12,slug:"role-playing-rpg",name:"Role-playing (RPG)"},
      {id:31,slug:"adventure",name:"Adventure"},
      {id:5,slug:"shooter",name:"Shooter"},
      {id:15,slug:"strategy",name:"Strategy"},
    ];
    const raceClient: IgdbClient = {async request(endpoint, query) {
      if (endpoint !== "games") return provider.request(endpoint, query);
      return {fetchedAt:providerTime,body:[{id:119133,name:"ELDEN RING",genres:incoming}]};
    }};
    const wrapped: IgdbEnrichmentStore = {...store, async applyPlan(plan) {
      const winner=incoming[applies++];
      await db.insert(genres).values({slug:winner.slug,name:winner.name});
      return store.applyPlan(plan);
    }};
    await expect(createIgdbEnricher({client:raceClient,store:wrapped}).enrichGame(1,{dryRun:false})).rejects.toMatchObject({code:"write_conflict"});
    expect(applies).toBe(3);
    expect(await db.select().from(genres)).toHaveLength(3);
    expect(await db.select().from(gameExternalIds).where(eq(gameExternalIds.provider,"igdb"))).toHaveLength(0);
  });

  it("preserves a previously resolved company suffix while recovering a compatible genre race", async () => {
    const {db,store}=await setup();let applies=0;
    await db.insert(companies).values({slug:"fromsoftware",name:"Different existing company"});
    const wrapped: IgdbEnrichmentStore={...store,async applyPlan(plan){
      if(++applies===1)await db.insert(genres).values({slug:"role-playing-rpg",name:"Role-playing (RPG)"});
      return store.applyPlan(plan);
    }};
    const result=await createIgdbEnricher({client:client(1,"genre-company"),store:wrapped}).enrichGame(1,{dryRun:false});
    expect(result.status).toBe("enrich");
    expect(applies).toBe(2);
    const snapshot=await store.findSnapshotByGameId(1);
    expect(snapshot?.companies.map(c=>c.name)).toEqual(["FromSoftware"]);
    expect(snapshot?.companies[0].slug).not.toBe("fromsoftware");
    expect(snapshot?.genres.map(g=>g.name)).toEqual(["Role-playing (RPG)"]);
  });
});
