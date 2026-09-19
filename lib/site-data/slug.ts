export const CANONICAL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_CANONICAL_SLUG_LENGTH = 160;

export function isCanonicalSlug(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CANONICAL_SLUG_LENGTH && CANONICAL_SLUG_PATTERN.test(value);
}

export function slugifyTaxonomy(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
