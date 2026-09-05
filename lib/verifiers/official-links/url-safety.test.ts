import { describe, expect, it } from "vitest";
import { resolveRedirectLocation, validateHttpUrl } from "./url-safety";

describe("validateHttpUrl", () => {
  it.each([
    {
      raw: "http://Example.COM/path",
      protocol: "http:" as const,
      hostname: "example.com",
      port: 80 as const,
    },
    {
      raw: "HTTPS://BÜCHER.COM./path?view=full#private-fragment",
      protocol: "https:" as const,
      hostname: "xn--bcher-kva.com",
      port: 443 as const,
    },
    {
      raw: "http://example.com:80/path",
      protocol: "http:" as const,
      hostname: "example.com",
      port: 80 as const,
    },
    {
      raw: "https://example.com:443/path",
      protocol: "https:" as const,
      hostname: "example.com",
      port: 443 as const,
    },
    {
      raw: "http://8.8.8.8/path",
      protocol: "http:" as const,
      hostname: "8.8.8.8",
      port: 80 as const,
    },
    {
      raw: "https://[2606:4700:4700::1111]/path",
      protocol: "https:" as const,
      hostname: "2606:4700:4700::1111",
      port: 443 as const,
    },
  ])("accepts and canonicalizes policy data for $raw", ({ raw, protocol, hostname, port }) => {
    const result = validateHttpUrl(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.exactUrl).toBe(raw);
    expect(result.value.protocol).toBe(protocol);
    expect(result.value.hostname).toBe(hostname);
    expect(result.value.port).toBe(port);
    expect(result.value.requestUrl.hash).toBe("");
  });

  it.each([
    "https://example.com",
    "https://notlocalhost.com",
    "https://public.localhost.example.com",
  ])("allows public multi-label hostname %s", (raw) => {
    expect(validateHttpUrl(raw).ok).toBe(true);
  });

  it.each([
    ["mailto:user@example.com", "unsupported_scheme"],
    ["ftp://example.com/file", "unsupported_scheme"],
    ["https://user@example.com", "unsafe_destination"],
    ["https://user:password@example.com", "unsafe_destination"],
    ["https://localhost/path", "unsafe_destination"],
    ["https://api.localhost/path", "unsafe_destination"],
    ["https://printer.local/path", "unsafe_destination"],
    ["https://service.internal/path", "unsafe_destination"],
    ["https://router.home.arpa/path", "unsafe_destination"],
    ["https://service.test/path", "unsafe_destination"],
    ["https://service.invalid/path", "unsafe_destination"],
    ["https://service.example/path", "unsafe_destination"],
    ["https://singlelabel/path", "unsafe_destination"],
    ["https://example.com:80/path", "unsafe_destination"],
    ["http://example.com:443/path", "unsafe_destination"],
    ["https://example.com:444/path", "unsafe_destination"],
    ["http://example.com:8080/path", "unsafe_destination"],
    ["not a URL", "invalid_url"],
    ["https://", "invalid_url"],
    ["", "invalid_url"],
  ] as const)("rejects %s with %s", (raw, code) => {
    expect(validateHttpUrl(raw)).toEqual({ ok: false, code });
  });

  it("accepts exactly 2,048 characters and rejects 2,049", () => {
    const prefix = "https://example.com/";
    const atLimit = `${prefix}${"a".repeat(2_048 - prefix.length)}`;
    const overLimit = `${prefix}${"a".repeat(2_049 - prefix.length)}`;

    expect(atLimit).toHaveLength(2_048);
    expect(validateHttpUrl(atLimit).ok).toBe(true);
    expect(validateHttpUrl(overLimit)).toEqual({ ok: false, code: "invalid_url" });
  });

  it("honors a stricter caller-provided length limit", () => {
    expect(validateHttpUrl("https://example.com/path", 10)).toEqual({
      ok: false,
      code: "invalid_url",
    });
  });
});

describe("resolveRedirectLocation", () => {
  it("resolves a relative Location and removes its fragment only from the request URL", () => {
    const result = resolveRedirectLocation(
      "https://Example.com/account/start?keep=yes",
      "../finish?token=internal#never-send",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.exactUrl).toBe(
      "https://example.com/finish?token=internal#never-send",
    );
    expect(result.value.requestUrl.href).toBe("https://example.com/finish?token=internal");
  });

  it("validates an absolute redirect under the same destination policy", () => {
    expect(
      resolveRedirectLocation("https://example.com/start", "http://service.internal/next"),
    ).toEqual({ ok: false, code: "unsafe_destination" });
  });

  it("rejects an overlong Location before resolution", () => {
    expect(
      resolveRedirectLocation("https://example.com/start", `/${"a".repeat(2_048)}`),
    ).toEqual({ ok: false, code: "invalid_url" });
  });

  it("fails closed when the base or Location is malformed", () => {
    expect(resolveRedirectLocation("not a base", "/next")).toEqual({
      ok: false,
      code: "invalid_url",
    });
    expect(resolveRedirectLocation("https://example.com", "http://[")).toEqual({
      ok: false,
      code: "invalid_url",
    });
  });
});
