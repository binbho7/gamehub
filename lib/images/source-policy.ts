export type ImageProvider = "steam" | "igdb";

export type SourcePolicyResult =
  | { ok: true; provider: ImageProvider; url: string }
  | {
    ok: false;
    reason:
      | "malformed_url"
      | "unsupported_scheme"
      | "credentials"
      | "fragment"
      | "too_long"
      | "unknown_host"
      | "provider_mismatch";
  };

const PROVIDER_HOSTS: Record<ImageProvider, readonly string[]> = {
  steam: ["cdn.akamai.steamstatic.com", "shared.akamai.steamstatic.com"],
  igdb: ["images.igdb.com"],
};

const MAX_SOURCE_URL_LENGTH = 2_048;

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function providerForHost(hostname: string): ImageProvider | null {
  for (const [provider, hosts] of Object.entries(PROVIDER_HOSTS) as Array<[ImageProvider, readonly string[]]>) {
    if (hosts.includes(hostname)) return provider;
  }
  return null;
}

export function resolveImageProviderFromUrl(
  url: string,
): { ok: true; provider: ImageProvider } | { ok: false; reason: "unknown_host" | "malformed_url" } {
  const parsed = parseUrl(url);
  if (parsed === null) return { ok: false, reason: "malformed_url" };
  if (parsed.port !== "") return { ok: false, reason: "unknown_host" };

  const provider = providerForHost(parsed.hostname);
  return provider === null
    ? { ok: false, reason: "unknown_host" }
    : { ok: true, provider };
}

export function validateImageSource(url: string, provider: ImageProvider): SourcePolicyResult {
  if (url.length > MAX_SOURCE_URL_LENGTH) return { ok: false, reason: "too_long" };

  const parsed = parseUrl(url);
  if (parsed === null) return { ok: false, reason: "malformed_url" };
  if (parsed.protocol !== "https:") return { ok: false, reason: "unsupported_scheme" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "credentials" };
  if (parsed.hash !== "") return { ok: false, reason: "fragment" };
  if (parsed.port !== "") return { ok: false, reason: "unknown_host" };

  const urlProvider = providerForHost(parsed.hostname);
  if (urlProvider === null) return { ok: false, reason: "unknown_host" };
  if (urlProvider !== provider) return { ok: false, reason: "provider_mismatch" };

  return { ok: true, provider, url };
}
