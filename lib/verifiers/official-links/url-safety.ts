import { isIP } from "node:net";

const DEFAULT_MAX_URL_LENGTH = 2_048;
const FORBIDDEN_HOSTNAME_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "test",
  "invalid",
  "example",
] as const;

export type SafeHttpUrl = {
  exactUrl: string;
  requestUrl: URL;
  protocol: "http:" | "https:";
  hostname: string;
  port: 80 | 443;
};

export type UrlSafetyResult =
  | { ok: true; value: SafeHttpUrl }
  | { ok: false; code: "invalid_url" | "unsupported_scheme" | "unsafe_destination" };

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  return withoutBrackets.endsWith(".") ? withoutBrackets.slice(0, -1) : withoutBrackets;
}

function isForbiddenHostname(hostname: string): boolean {
  if (hostname.length === 0) return true;
  if (isIP(hostname) !== 0) return false;
  if (!hostname.includes(".")) return true;

  return FORBIDDEN_HOSTNAME_SUFFIXES.some(
    (forbidden) => hostname === forbidden || hostname.endsWith(`.${forbidden}`),
  );
}

export function validateHttpUrl(
  raw: string,
  maxLength = DEFAULT_MAX_URL_LENGTH,
): UrlSafetyResult {
  if (raw.length === 0 || raw.length > maxLength) {
    return { ok: false, code: "invalid_url" };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "unsupported_scheme" };
  }

  const protocol = parsed.protocol;
  const hostname = normalizedHostname(parsed);
  const expectedPort = protocol === "http:" ? 80 : 443;
  const explicitPort = parsed.port === "" ? expectedPort : Number(parsed.port);

  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    isForbiddenHostname(hostname) ||
    explicitPort !== expectedPort
  ) {
    return { ok: false, code: "unsafe_destination" };
  }

  const requestUrl = new URL(parsed.href);
  requestUrl.hash = "";

  return {
    ok: true,
    value: {
      exactUrl: raw,
      requestUrl,
      protocol,
      hostname,
      port: expectedPort,
    },
  };
}

export function resolveRedirectLocation(
  currentExactUrl: string,
  location: string,
): UrlSafetyResult {
  if (location.length === 0 || location.length > DEFAULT_MAX_URL_LENGTH) {
    return { ok: false, code: "invalid_url" };
  }

  let resolved: URL;
  try {
    resolved = new URL(location, currentExactUrl);
  } catch {
    return { ok: false, code: "invalid_url" };
  }

  return validateHttpUrl(resolved.href);
}
