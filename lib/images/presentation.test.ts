import { describe, expect, it } from "vitest";
import type { ImageResult } from "./types";
import { formatImageResultHuman, presentImageResult } from "./presentation";

const sensitiveKeys = [
  "token", "access_token", "auth", "authorization", "key", "api_key", "apikey",
  "signature", "sig", "secret", "credential", "x-amz-signature", "x-amz-credential",
] as const;

type RichImageResult = ImageResult & {
  plan: {
    gameId: number;
    dryRun: boolean;
    candidates: Array<{ sourceUrl: string; provider: string; type: string }>;
  };
  errors: Array<{ message: string; url: string }>;
  images: Array<ImageResult["images"][number] & {
    sourceUrl: string;
    attempts: Array<{ method: "GET"; url: string; error: { message: string; url: string } }>;
    redirectChain: Array<{ fromUrl: string; location: string; resolvedUrl: string | null; status: 301 }>;
    finalUrl: string | null;
  }>;
};

function url(label: string): string {
  const query = sensitiveKeys.map((key, index) => `${key.toUpperCase()}=${label}-secret-${index}`).join("&");
  return `https://user-${label}:password-${label}@cdn.example.test/${label}?${query}&public=ok#${label}-fragment`;
}

function richResult(): RichImageResult {
  const original = url("original");
  const location = url("location");
  const final = url("final");
  return {
    gameId: 10,
    status: "partial",
    preflightError: null,
    plan: { gameId: 10, dryRun: true, candidates: [{ sourceUrl: original, provider: "steam", type: "cover" }] },
    errors: [{ message: `failed at ${location}`, url: final }],
    images: [{
      imageId: 11,
      outcome: "download_failed",
      sourceUrl: original,
      attempts: [{ method: "GET", url: location, error: { message: `redirected to ${final}`, url: final } }],
      redirectChain: [{ fromUrl: original, location, resolvedUrl: final, status: 301 }],
      finalUrl: final,
    }],
  };
}

describe("image result presentation", () => {
  it("sanitizes every image URL-bearing field, plan URL, and nested error", () => {
    const result = richResult();
    const presented = presentImageResult(result);
    const rendered = JSON.stringify(presented);

    expect(presented.images[0]).toMatchObject({
      imageId: 11,
      outcome: "download_failed",
      sourceUrl: expect.stringContaining("public=ok"),
      finalUrl: expect.stringContaining("public=ok"),
    });
    expect((presented as typeof presented & { plan: RichImageResult["plan"] }).plan.candidates[0]?.sourceUrl)
      .toContain("public=ok");
    for (const marker of ["original", "location", "final"]) {
      expect(rendered).not.toContain(`secret-${marker}`);
      expect(rendered).not.toContain(`user-${marker}`);
      expect(rendered).not.toContain(`password-${marker}`);
      expect(rendered).not.toContain(`${marker}-fragment`);
    }
    expect(rendered.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(sensitiveKeys.length * 3);
    expect(rendered).toContain("cdn.example.test");
  });

  it("uses the shared fail-closed malformed URL sentinel", () => {
    const result = {
      gameId: 10,
      status: "failed",
      preflightError: null,
      images: [{
        imageId: 11,
        outcome: "download_failed",
        sourceUrl: "https://[raw-malformed-secret",
        attempts: [],
        redirectChain: [],
        finalUrl: null,
      }],
    } as unknown as ImageResult;

    expect(JSON.stringify(presentImageResult(result))).toContain("[INVALID_URL]");
    expect(JSON.stringify(presentImageResult(result))).not.toContain("raw-malformed-secret");
  });

  it("formats only the sanitized DTO for human output", () => {
    const result = richResult();
    const output = formatImageResultHuman(presentImageResult(result));

    expect(output).toContain("Image ingest game 10: partial");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("original-secret");
    expect(output).not.toContain("location-secret");
    expect(output).not.toContain("final-secret");
    expect(output).not.toContain("password-");
  });
});
