import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { expect, it } from "vitest";
import { assertCronDeploymentReady } from "../../workers/cron-sync/src/config";

function config(path: string) {
  const url = new URL(path, import.meta.url);
  const parsed = ts.parseConfigFileTextToJson(url.pathname, readFileSync(url, "utf8"));
  if (parsed.error) throw new Error("Invalid Wrangler JSONC");
  return parsed.config;
}

it("ships private, disabled Cron and Image configuration and rejects unresolved production identity", () => {
  const cron = config("../../workers/cron-sync/wrangler.jsonc");
  const image = config("../../workers/image-ingest/wrangler.jsonc");
  expect(() => assertCronDeploymentReady(cron.env.production, image.env.production, true)).toThrow();
  const id = "11111111-2222-4333-8444-555555555555";
  const productionCron = structuredClone(cron.env.production);
  const productionImage = structuredClone(image.env.production);
  productionCron.d1_databases[0].database_id = id;
  productionImage.d1_databases[0].database_id = id;
  expect(productionCron.triggers.crons).toEqual([]);
  expect(() => assertCronDeploymentReady(productionCron, productionImage, true)).not.toThrow();
  expect(() => assertCronDeploymentReady(productionCron, productionImage, false)).toThrow();
  for (const change of [{ workers_dev: true }, { preview_urls: true }, { routes: ["example.test/*"] }, { limits: { cpu_ms: 10000 } }, { triggers: { crons: ["* * * * *"] } }]) {
    expect(() => assertCronDeploymentReady({ ...productionCron, ...change }, productionImage, true)).toThrow();
  }
  productionImage.d1_databases[0].database_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  expect(() => assertCronDeploymentReady(productionCron, productionImage, true)).toThrow();
});

it("makes the operator readiness command fail without deployment credentials or shared production bindings", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "workers/cron-sync/check-deployment.ts"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8", env: { ...process.env, CRON_PAID_PLAN_CONFIRMED: "true" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Cron deployment is not ready");
  expect(result.stdout).not.toContain("ready");
});

it("pins the sole added platform dependency and the Node image used for verifier execution", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
  expect(packageJson.dependencies["@cloudflare/containers"]).toMatch(/^\d+\.\d+\.\d+$/);
  expect(lock.packages["node_modules/@cloudflare/containers"].version).toBe(packageJson.dependencies["@cloudflare/containers"]);
  const dockerfile = readFileSync(new URL("../../containers/official-link-verifier/Dockerfile", import.meta.url), "utf8");
  const images = dockerfile.split("\n").filter(line => line.startsWith("FROM ")).map(line => line.split(" ")[1]);
  expect(images).toHaveLength(2);
  expect(images[0]).toMatch(/^node:24\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/);
  expect(images[1]).toBe(images[0]);
});
