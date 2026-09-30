import { cp, lstat, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const ROOT_FILES = new Set(["components.json", "next-env.d.ts", "next.config.ts", "package-lock.json", "package.json", "postcss.config.mjs", "tsconfig.json"]);
const PRODUCTION_ROOTS = ["app/", "components/", "public/", "types/"];
const PRODUCTION_LIBRARY_FILES = new Set([
  "lib/catalog-pagination.ts", "lib/game-filter.ts", "lib/game-query.ts", "lib/home-query.ts", "lib/search-contract.ts", "lib/static-query.ts", "lib/utils.ts",
  "lib/site-data/contracts.ts", "lib/site-data/navigation.ts", "lib/site-data/presentation-policy.ts", "lib/site-data/serialize.ts", "lib/site-data/slug.ts", "lib/site-data/source.ts", "lib/site-data/validation.ts",
  "lib/verifiers/official-links/ip-safety.ts", "lib/verifiers/official-links/url-safety.ts",
]);
const FORBIDDEN_SEGMENTS = new Set(["__fixtures__", "__mocks__", "__tests__", "fixture", "fixtures", "test", "tests", "test-support"]);

export function isProductionBuildInput(input: string, tracked: boolean): boolean {
  if (!tracked || input.length === 0 || input.startsWith("/") || input.includes("\\")) return false;
  const path = input.split("/");
  if (path.some((part) => part === "" || part === "." || part === ".." || FORBIDDEN_SEGMENTS.has(part))) return false;
  const name = path.at(-1)!;
  if (name.startsWith(".env") || name.startsWith(".dev.vars") || name === ".npmrc") return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return false;
  if (input === "lib/mock-data.ts" || input === "lib/site-data/fixture-source.ts") return false;
  if (input.startsWith("drizzle/meta/") && input.endsWith("_snapshot.json")) return false;
  if (ROOT_FILES.has(input) || PRODUCTION_LIBRARY_FILES.has(input) || input === "scripts/check-site-data.ts") return true;
  return PRODUCTION_ROOTS.some((root) => input.startsWith(root));
}
export async function copyTrackedProductionInputs(projectRoot: string, buildRoot: string, trackedFiles: readonly string[]): Promise<void> {
  for (const path of trackedFiles) {
    if (!isProductionBuildInput(path, true)) continue;
    const source = resolve(projectRoot, path); const destination = resolve(buildRoot, path); const metadata = await lstat(source);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`invalid production build input: ${path}`);
    await mkdir(dirname(destination), { recursive: true }); await cp(source, destination);
  }
}
export async function copyProductionBuildInputs(projectRoot: string, buildRoot: string, trackedFiles: readonly string[]): Promise<void> {
  await copyTrackedProductionInputs(projectRoot, buildRoot, trackedFiles);
  const dependencies = resolve(projectRoot, "node_modules"); const metadata = await lstat(dependencies);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("node_modules must be a physical directory");
  await cp(dependencies, resolve(buildRoot, "node_modules"), { recursive: true, verbatimSymlinks: true });
}
export function trackedFileList(value: string): string[] { return value.split("\0").filter(Boolean).map((path) => path.split(sep).join("/")); }
export function productionBuildEnvironment(source: Record<string, string | undefined>, buildRoot: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: "production", CRON_BATCH_SIZE: "1" };
  for (const name of ["CI", "HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TERM", "TMP", "TMPDIR"]) if (source[name] !== undefined) result[name] = source[name];
  return { ...result, NPM_CONFIG_USERCONFIG: resolve(buildRoot, ".npmrc-disabled"), NEXT_TELEMETRY_DISABLED: "1" };
}
