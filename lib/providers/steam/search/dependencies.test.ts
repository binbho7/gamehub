import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const forbidden = [
  /(?:^|\/)lib\/db\//,
  /(?:^|\/)lib\/importers\//,
  /^\.\.\/\.\.\/\.\.\/db\//,
  /^\.\.\/\.\.\/\.\.\/importers\//,
  /^\.\.\/client(?:$|\/)/,
  /^\.\.\/response(?:$|\/)/,
  /^\.\.\/normalize(?:$|\/)/,
];

function findForbiddenDependencyImports(source: string): string[] {
  const sourceFile = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];

  function inspectModuleSpecifier(moduleSpecifier: ts.Expression | undefined) {
    if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      inspectModuleSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      inspectModuleSpecifier(node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      inspectModuleSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)));
}

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
  it("detects forbidden side-effect and dynamic imports", () => {
    expect(findForbiddenDependencyImports([
      'import "../client";',
      'await import("../response");',
    ].join("\n"))).toEqual(["../client", "../response"]);
  });

  it("does not reach into V2.2 details, importers, or D1 modules", async () => {
    const searchRoot = fileURLToPath(new URL(".", import.meta.url));
    const files = await productionTypeScriptFiles(searchRoot);
    const violations = (await Promise.all(files.map(async (file) => ({
      file,
      source: await readFile(file, "utf8"),
    })))).flatMap(({ file, source }) => findForbiddenDependencyImports(source).map(
      (specifier) => `${file}: ${specifier}`,
    ));

    expect(violations).toEqual([]);
  });
});
