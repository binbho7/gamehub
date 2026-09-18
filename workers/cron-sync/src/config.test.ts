import { describe, expect, it } from "vitest";
import { assertCronDeploymentReady, parseCronWorkerEnvironment } from "./config";

export function environment() {
  return {
    DB: { prepare() {}, batch() {} }, IMAGE_INGEST: { fetch() {} },
    VERIFIER_CONTAINER: { idFromName() {}, get() {} },
    TWITCH_CLIENT_ID: "client", TWITCH_CLIENT_SECRET: "twitch-secret",
    VERIFIER_SERVICE_SECRET: "verifier-secret", IMAGE_INGEST_SCHEDULED_TOKEN: "scheduled-secret",
  };
}

describe("Cron environment", () => {
  it("uses bounded scheduler defaults and parses decimal overrides", () => {
    expect(parseCronWorkerEnvironment({ ...environment(), CRON_BATCH_SIZE: "1" }).sync)
      .toMatchObject({ batchSize: 1, leaseDurationMs: 1_500_000, platformWallBudgetMs: 900_000 });
  });
  it.each(["", " 1", "1 ", "01", "1.0", "1e1", "0", "26", "NaN"])("rejects ambiguous/out-of-range batch %j", value => {
    expect(() => parseCronWorkerEnvironment({ ...environment(), CRON_BATCH_SIZE: value })).toThrow();
  });
  it.each([
    { DB: {} }, { IMAGE_INGEST: {} }, { VERIFIER_CONTAINER: {} },
    { TWITCH_CLIENT_SECRET: "" }, { IMAGE_INGEST_SCHEDULED_TOKEN: "bad token" },
    { IMAGES_BUCKET: {} }, { IMAGE_INGEST_TOKEN: "legacy" }, { CRON_SOFT_DEADLINE_MS: "900000" },
  ])("fails closed on missing capabilities and unsafe configuration %j", change => {
    let error: unknown;
    try { parseCronWorkerEnvironment({ ...environment(), ...change }); } catch (cause) { error = cause; }
    expect(error).toEqual({ code: "configuration_error", message: "The Cron sync configuration is invalid." });
  });
});

it("rejects placeholder/mismatched D1 and insufficient CPU at deployment readiness", () => {
  const database = { binding: "DB", database_id: "11111111-2222-4333-8444-555555555555" };
  const cron = { workers_dev: false, preview_urls: false, routes: [], limits: { cpu_ms: 300000 },
    d1_databases: [database], services: [{ binding: "IMAGE_INGEST", service: "gamehub-image-ingest-production" }],
    triggers: { crons: [] }, containers: [{ max_instances: 1 }] };
  const image = { name: "gamehub-image-ingest-production", workers_dev: false, preview_urls: false, routes: [], d1_databases: [database] };
  expect(() => assertCronDeploymentReady(cron, image, true)).not.toThrow();
  for (const change of [{ limits: { cpu_ms: 10000 } }, { workers_dev: true }, { routes: ["example.com/*"] },
    { d1_databases: [{ ...database, database_id: "REPLACE_WITH_PRODUCTION_D1_ID" }] },
    { d1_databases: [{ ...database, database_id: "00000000-0000-0000-0000-000000000000" }] },
    { d1_databases: [{ ...database, database_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }] }]) {
    expect(() => assertCronDeploymentReady({ ...cron, ...change }, image, true)).toThrow();
  }
  expect(() => assertCronDeploymentReady(cron, image, false)).toThrow();
});
