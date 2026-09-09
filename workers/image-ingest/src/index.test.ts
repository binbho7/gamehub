import { describe, expect, it, vi } from "vitest";
import { handleImageIngest, type ImageIngestWorkerDependencies, type WorkerEnv } from "./index";
import type { ImageResult } from "../../../lib/images/types";
import { imageItemFixture } from "../../../test/helpers/image-result-fixture";

const env = {
  DB: {},
  IMAGES_BUCKET: {},
  IMAGE_PUBLIC_BASE_URL: "https://images.example.test",
  IMAGE_INGEST_TOKEN: "worker-secret",
} as unknown as WorkerEnv;

const result: ImageResult = {
  gameId: 7,
  status: "completed",
  preflightError: null,
  plan: null,
  images: [imageItemFixture({ imageId: 12, outcome: "ingested" })],
};

function deps(overrides: Partial<ImageIngestWorkerDependencies> = {}): ImageIngestWorkerDependencies {
  return {
    serviceFactory: vi.fn(() => ({ ingest: vi.fn(async () => result) })),
    ...overrides,
  };
}

function ctx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

describe("image ingest worker handler", () => {
  it("rejects wrong method and path without invoking the service", async () => {
    const serviceFactory = vi.fn();
    const dependencies = deps({ serviceFactory });
    await expect(handleImageIngest(new Request("https://worker.example/", { method: "GET" }), env, ctx(), dependencies)).resolves.toMatchObject({ status: 404 });
    await expect(handleImageIngest(new Request("https://worker.example/internal/images/ingest", { method: "GET" }), env, ctx(), dependencies)).resolves.toMatchObject({ status: 405 });
    expect(serviceFactory).not.toHaveBeenCalled();
  });

  it("requires the bearer token before parsing or service dispatch", async () => {
    const serviceFactory = vi.fn();
    const response = await handleImageIngest(new Request("https://worker.example/internal/images/ingest", {
      method: "POST",
      body: JSON.stringify({ gameId: 7, write: false }),
    }), env, ctx(), deps({ serviceFactory }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
    expect(serviceFactory).not.toHaveBeenCalled();
  });

  it("dispatches a dry-run and presents a sanitized JSON result", async () => {
    const ingest = vi.fn(async () => ({ ...result, images: [{ imageId: 12, outcome: "ingested", sourceUrl: "https://cdn.akamai.steamstatic.com/a.jpg?token=super-secret" }] } as unknown as ImageResult));
    const response = await handleImageIngest(new Request("https://worker.example/internal/images/ingest", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret" },
      body: JSON.stringify({ gameId: 7, write: false }),
    }), env, ctx(), deps({ serviceFactory: vi.fn(() => ({ ingest })) }));
    expect(response.status).toBe(200);
    expect(ingest).toHaveBeenCalledWith(7, { write: false, signal: expect.any(AbortSignal) });
    const serialized = await response.text();
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("worker-secret");
  });

  it("maps invalid payloads to a safe 400 response", async () => {
    const response = await handleImageIngest(new Request("https://worker.example/internal/images/ingest", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret" },
      body: JSON.stringify({ gameId: 7, write: false, url: "https://evil.example?token=secret" }),
    }), env, ctx(), deps());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Invalid request" } });
  });

  it("maps service exceptions to a generic safe response without logging", async () => {
    const error = new Error("secret URL https://evil.example/?token=top-secret");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await handleImageIngest(new Request("https://worker.example/internal/images/ingest", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret" },
      body: JSON.stringify({ gameId: 7, write: true }),
    }), env, ctx(), deps({ serviceFactory: vi.fn(() => ({ ingest: vi.fn().mockRejectedValue(error) })) }));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe(JSON.stringify({ error: { code: "internal_error", message: "Image ingest failed" } }));
    expect(body).not.toContain("top-secret");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("rejects unsafe configuration before service dispatch", async () => {
    const serviceFactory = vi.fn();
    const response = await handleImageIngest(new Request("https://worker.example/internal/images/ingest", {
      method: "POST",
      headers: { Authorization: "Bearer worker-secret" },
      body: JSON.stringify({ gameId: 7, write: false }),
    }), { ...env, IMAGE_PUBLIC_BASE_URL: "https://bucket.r2.dev" }, ctx(), deps({ serviceFactory }));
    expect(response.status).toBe(500);
    expect(serviceFactory).not.toHaveBeenCalled();
  });
});
