import { readFileSync } from "node:fs";
import ts from "typescript";
import { assertCronDeploymentReady } from "./src/config";

try {
  const readProduction = (url: URL): unknown => {
    const parsed = ts.parseConfigFileTextToJson(url.pathname, readFileSync(url, "utf8"));
    if (parsed.error) throw new Error("Invalid deployment configuration");
    return parsed.config?.env?.production;
  };
  assertCronDeploymentReady(readProduction(new URL("./wrangler.jsonc", import.meta.url)),
    readProduction(new URL("../image-ingest/wrangler.jsonc", import.meta.url)),
    process.env.CRON_PAID_PLAN_CONFIRMED === "true");
  console.log("Cron deployment bindings and paid-tier confirmation are ready; operational rollout gates still apply.");
} catch {
  console.error("Cron deployment is not ready: verify real shared D1 IDs, private service bindings, CPU limit, and paid plan confirmation.");
  process.exitCode = 1;
}
