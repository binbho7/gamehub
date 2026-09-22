import { describe, expect, it } from "vitest";
import {
  resolveImageProviderFromUrl,
  validateImageSource,
} from "./source-policy";

describe("image source policy", () => {
  it.each(["cdn.akamai.steamstatic.com", "shared.akamai.steamstatic.com"])("trusts only the exact approved Steam host %s", (host) => {
    const url = `https://${host}/steam/apps/1245620/header.jpg`;
    expect(validateImageSource(url, "steam")).toEqual({ ok: true, provider: "steam", url });
    expect(resolveImageProviderFromUrl(url)).toEqual({ ok: true, provider: "steam" });
    expect(validateImageSource(url, "igdb")).toEqual({ ok: false, reason: "provider_mismatch" });
    for (const bad of [`https://${host}.evil.test/a.jpg`, `https://evil.${host}/a.jpg`, `https://${host}:444/a.jpg`]) {
      expect(validateImageSource(bad, "steam")).toEqual({ ok: false, reason: "unknown_host" });
    }
    expect(validateImageSource(`http://${host}/a.jpg`, "steam")).toEqual({ ok: false, reason: "unsupported_scheme" });
    expect(validateImageSource(`https://user:pass@${host}/a.jpg`, "steam")).toEqual({ ok: false, reason: "credentials" });
    expect(validateImageSource(url + "#fragment", "steam")).toEqual({ ok: false, reason: "fragment" });
    expect(validateImageSource(url + "a".repeat(2048), "steam")).toEqual({ ok: false, reason: "too_long" });
  });
  it("accepts only the exact HTTPS host assigned to each provider", () => {
    expect(validateImageSource(
      "https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg",
      "steam",
    )).toEqual({
      ok: true,
      provider: "steam",
      url: "https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg",
    });
    expect(validateImageSource(
      "https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg",
      "igdb",
    )).toMatchObject({ ok: true, provider: "igdb" });

    expect(validateImageSource(
      "https://steamstatic.com/steam/apps/10/header.jpg",
      "steam",
    )).toEqual({ ok: false, reason: "unknown_host" });
    expect(validateImageSource(
      "https://cdn.akamai.steamstatic.com.evil.test/steam/apps/10/header.jpg",
      "steam",
    )).toEqual({ ok: false, reason: "unknown_host" });
    expect(validateImageSource(
      "https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg",
      "steam",
    )).toEqual({ ok: false, reason: "provider_mismatch" });
  });

  it.each([
    ["http://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg", "unsupported_scheme"],
    ["https://user:pass@cdn.akamai.steamstatic.com/steam/apps/10/header.jpg", "credentials"],
    ["https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg#fragment", "fragment"],
    ["not a URL", "malformed_url"],
  ] as const)("rejects unsafe source URLs: %s", (url, reason) => {
    expect(validateImageSource(url, "steam")).toEqual({ ok: false, reason });
  });

  it("rejects a URL longer than 2,048 characters before it can be used", () => {
    const url = `https://cdn.akamai.steamstatic.com/${"a".repeat(2_014)}`;

    expect(url).toHaveLength(2_049);
    expect(validateImageSource(url, "steam")).toEqual({ ok: false, reason: "too_long" });
  });

  it("infers a provider only from an exact mapped host", () => {
    expect(resolveImageProviderFromUrl(
      "https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg",
    )).toEqual({ ok: true, provider: "steam" });
    expect(resolveImageProviderFromUrl(
      "https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg",
    )).toEqual({ ok: true, provider: "igdb" });
    expect(resolveImageProviderFromUrl(
      "https://cdn.cloudflare.steamstatic.com/steam/apps/10/header.jpg",
    )).toEqual({ ok: false, reason: "unknown_host" });
    expect(resolveImageProviderFromUrl("not a URL")).toEqual({
      ok: false,
      reason: "malformed_url",
    });
  });

  it.each([
    ["steam", "https://cdn.akamai.steamstatic.com:444/steam/apps/10/header.jpg"],
    ["igdb", "https://images.igdb.com:444/igdb/image/upload/t_cover_big/co1.jpg"],
  ] as const)("rejects a non-default HTTPS port for %s", (provider, url) => {
    expect(resolveImageProviderFromUrl(url)).toEqual({ ok: false, reason: "unknown_host" });
    expect(validateImageSource(url, provider)).toEqual({ ok: false, reason: "unknown_host" });
  });
});
