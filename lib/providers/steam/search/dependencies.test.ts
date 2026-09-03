import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const forbidden = [
  /from ["'].*lib\/db\//,
  /from ["'].*lib\/importers\//,
  /from ["']\.\.\/\.\.\/\.\.\/db\//,
  /from ["']\.\.\/\.\.\/\.\.\/importers\//,
  /from ["']\.\.\/client["']/,
  /from ["']\.\.\/response["']/,
  /from ["']\.\.\/normalize["']/,
];

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("Steam search production dependencies", () => {
  it("does not reach into V2.2 details, importers, or D1 modules", async () => {
    const searchRoot = fileURLToPath(new URL(".", import.meta.url));
    const files = await productionTypeScriptFiles(searchRoot);
    const violations = (await Promise.all(files.map(async (file) => ({
      file,
      source: await readFile(file, "utf8"),
    })))).flatMap(({ file, source }) => forbidden.flatMap((pattern) => (
      source.match(pattern) ? [`${file}: ${pattern}`] : []
    )));

    expect(violations).toEqual([]);
  });
});
