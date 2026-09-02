const MAX_SLUG_LENGTH = 160;

function normalizedAscii(value: string): string {
  return value
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toCanonicalSlug(value: string, fallback: string): string {
  const normalized = normalizedAscii(value).slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  return normalized || fallback;
}

export async function companyCollisionSlug(
  baseSlug: string,
  normalizedName: string,
  hashLength = 8,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedName));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, hashLength);
  const maxBaseLength = Math.max(0, MAX_SLUG_LENGTH - hash.length - 1);
  const base = baseSlug.slice(0, maxBaseLength).replace(/-+$/g, "");
  return `${base}-${hash}`;
}
