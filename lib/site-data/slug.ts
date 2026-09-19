export function slugifyTaxonomy(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
