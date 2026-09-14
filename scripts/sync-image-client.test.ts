import { describe, expect, it, vi } from "vitest";
import { IMAGE_OUTCOMES } from "../lib/sync/image-stage";
import { stageError } from "../lib/sync/stages";
import { createImageWorkerClient, parseImageWorkerResponse } from "./sync-image-client";

function validResponse(write = false) {
  return {
    gameId: 41,
    status: "completed",
    preflightError: null,
    plan: {
      gameId: 41,
      gameSnapshot: {
        id: 41,
        coverUrl: "https://example.test/cover.jpg",
        heroUrl: null,
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
      candidates: [{
        gameId: 41,
        type: "cover",
        sourceUrl: "https://example.test/cover.jpg",
        provider: "steam",
        width: null,
        height: null,
        sortOrder: 0,
        existingId: null,
        mode: write ? "write" : "read_only",
        reason: "create_missing_scalar",
      }],
      rejected: [],
      preflight: "ok",
      dryRun: !write,
    },
    images: [{
      imageId: null,
      outcome: "skipped",
      sourceUrl: "https://example.test/cover.jpg",
      presentationUrl: "https://example.test/cover.jpg",
      provider: "steam",
      attempts: [{
        url: "https://example.test/cover.jpg",
        presentationUrl: "https://example.test/cover.jpg",
        provider: "steam",
        method: "GET",
        hopStatus: "response",
        status: 200,
        headers: { contentType: "image/jpeg", contentLength: "3" },
        location: null,
        redirectChain: [],
        finalUrl: "https://example.test/cover.jpg",
        selectedMimeType: "image/jpeg",
        byteCount: 3,
        contentHash: "abc",
        dimensions: { width: 1, height: 1 },
        timing: { startedAt: 1, finishedAt: 2, durationMs: 1 },
        errorCode: null,
      }],
      redirectChain: [],
      finalUrl: "https://example.test/cover.jpg",
      httpStatus: 200,
      selectedMimeType: "image/jpeg",
      byteCount: 3,
      contentHash: "abc",
      dimensions: { width: 1, height: 1 },
      timing: { startedAt: 1, finishedAt: 2, durationMs: 1 },
      error: null,
    }],
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

async function expectInvalid(value: unknown, write = false) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(value));
  const client = createImageWorkerClient({
    workerUrl: "http://127.0.0.1:8787/internal/images/ingest",
    token: "fixture-token",
    fetchImpl,
  });
  const rejection = await client.ingest(41, { write }).catch((error: unknown) => error);
  expect(rejection).toEqual(stageError("images", "worker_invalid_response"));
  expect(JSON.stringify(rejection)).not.toContain("fixture-token");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
}

describe("createImageWorkerClient", () => {
  it("builds one authenticated local request and fails closed on wrong gameId", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      ...validResponse(),
      gameId: 42,
    }));
    const client = createImageWorkerClient({
      workerUrl: "http://127.0.0.1:8787/internal/images/ingest",
      token: "fixture-token",
      fetchImpl,
    });

    await expect(client.ingest(41, { write: false }))
      .rejects.toEqual(stageError("images", "worker_invalid_response"));
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:8787/internal/images/ingest",
      {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer fixture-token",
        },
        body: JSON.stringify({ gameId: 41, write: false }),
      },
    );
  });

  it("maps a secret-bearing network rejection to a fixed public error without retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("token=network-secret"));
    const client = createImageWorkerClient({ workerUrl: "http://127.0.0.1:8787/internal/images/ingest", token: "fixture-token", fetchImpl });
    const rejection = await client.ingest(41, { write: false }).catch((error: unknown) => error);
    expect(rejection).toEqual(stageError("images", "worker_network_error"));
    expect(JSON.stringify(rejection)).not.toContain("network-secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500, 302])("maps HTTP %i to a fixed public error without reading its body", async (status) => {
    const body = new ReadableStream({
      pull() { throw new Error("body-secret"); },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const client = createImageWorkerClient({ workerUrl: "http://127.0.0.1:8787/internal/images/ingest", token: "fixture-token", fetchImpl });
    const rejection = await client.ingest(41, { write: false }).catch((error: unknown) => error);
    expect(rejection).toEqual(stageError("images", "worker_http_error"));
    expect(JSON.stringify(rejection)).not.toContain("body-secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps invalid JSON to the fixed invalid-response error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret malformed {", { status: 200 }));
    const client = createImageWorkerClient({ workerUrl: "http://127.0.0.1:8787/internal/images/ingest", token: "fixture-token", fetchImpl });
    const rejection = await client.ingest(41, { write: false }).catch((error: unknown) => error);
    expect(rejection).toEqual(stageError("images", "worker_invalid_response"));
    expect(JSON.stringify(rejection)).not.toContain("secret malformed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("parseImageWorkerResponse", () => {
  it.each([null, [], 1, "bad", {}])("rejects malformed object %#", async (value) => {
    await expectInvalid(value);
  });

  it.each(["gameId", "status", "preflightError", "plan", "images"])("rejects a response missing root property %s", async (key) => {
    const value = validResponse() as Record<string, unknown>;
    delete value[key];
    await expectInvalid(value);
  });

  it.each([
    ["plan", (value: ReturnType<typeof validResponse>) => { value.plan.gameId = 42; }],
    ["snapshot", (value: ReturnType<typeof validResponse>) => { value.plan.gameSnapshot!.id = 42; }],
    ["candidate", (value: ReturnType<typeof validResponse>) => { value.plan.candidates[0].gameId = 42; }],
  ])("rejects wrong %s identity", async (_name, mutate) => {
    const value = validResponse();
    mutate(value);
    await expectInvalid(value);
  });

  it("rejects unexpected aggregate status", async () => {
    await expectInvalid({ ...validResponse(), status: "mystery" });
  });

  it("rejects every unexpected image outcome", async () => {
    const value = validResponse();
    value.images[0].outcome = "mystery";
    await expectInvalid(value);
  });

  it.each([
    ["attempt location", (value: ReturnType<typeof validResponse>) => { delete (value.images[0].attempts[0] as unknown as Record<string, unknown>).location; }],
    ["attempt timing", (value: ReturnType<typeof validResponse>) => { delete (value.images[0].attempts[0].timing as unknown as Record<string, unknown>).durationMs; }],
    ["item error", (value: ReturnType<typeof validResponse>) => {
      value.images[0].error = { stage: "download", code: "safe" } as never;
      delete (value.images[0].error as unknown as Record<string, unknown>).code;
    }],
    ["redirect location", (value: ReturnType<typeof validResponse>) => {
      const image = value.images[0] as unknown as Record<string, unknown>;
      image.redirectChain = [{ fromUrl: "https://a.test", location: "https://b.test", resolvedUrl: "https://b.test", status: 302 }];
      delete ((image.redirectChain as Array<Record<string, unknown>>)[0]).location;
    }],
  ])("rejects missing required nested %s property", async (_name, mutate) => {
    const value = validResponse();
    mutate(value);
    await expectInvalid(value);
  });

  it.each([
    ["plan dryRun", (value: ReturnType<typeof validResponse>) => { value.plan.dryRun = false; }],
    ["write candidate in dry-run", (value: ReturnType<typeof validResponse>) => { value.plan.candidates[0].mode = "write"; }],
  ])("rejects wrong mode: %s", async (_name, mutate) => {
    const value = validResponse();
    mutate(value);
    await expectInvalid(value);
  });

  it.each([
    ["preflight error", (value: ReturnType<typeof validResponse>) => {
      (value as unknown as Record<string, unknown>).preflightError = "game_deadline";
    }],
    ["failed outcome", (value: ReturnType<typeof validResponse>) => { value.images[0].outcome = "download_failed"; }],
  ])("rejects contradictory completion with %s", async (_name, mutate) => {
    const value = validResponse();
    mutate(value);
    await expectInvalid(value);
  });

  it("accepts every native image outcome when the aggregate status is not completed", () => {
    for (const outcome of IMAGE_OUTCOMES) {
      const value = validResponse();
      value.status = outcome === "skipped" ? "completed" : "partial";
      value.images[0].outcome = outcome;
      expect(parseImageWorkerResponse(value, 41, false).images[0].outcome).toBe(outcome);
    }
  });

  it("round-trips a valid ISO game timestamp to Date", () => {
    const result = parseImageWorkerResponse(validResponse(), 41, false);
    expect(result.plan?.gameSnapshot?.updatedAt).toEqual(new Date("2026-09-10T00:00:00.000Z"));
  });
});
