import { describe, expect, it } from "vitest";
import { parseWorkerRequest } from "./request";

function request(body: unknown, headers?: HeadersInit): Request {
  return new Request("https://worker.example/internal/images/ingest", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
}

describe("image ingest worker request parser", () => {
  it("parses the exact request DTO", async () => {
    await expect(parseWorkerRequest(request({ gameId: 42, write: true }))).resolves.toEqual({ gameId: 42, write: true });
  });

  it.each([
    { gameId: 0, write: false },
    { gameId: -1, write: false },
    { gameId: 1.5, write: false },
    { gameId: "1", write: false },
    { gameId: 1, write: "false" },
    { gameId: 1, write: false, token: "secret" },
    { gameId: 1, write: false, url: "https://evil.example" },
    { gameId: 1, write: false, provider: "steam" },
    { gameId: 1, write: false, storageKey: "images/secret" },
    [1, false],
  ])("rejects non-contract payload %j", async (body) => {
    await expect(parseWorkerRequest(request(body))).rejects.toThrow("invalid_request");
  });

  it("rejects invalid JSON and an empty body", async () => {
    await expect(parseWorkerRequest(request("not-json"))).rejects.toThrow("invalid_request");
    await expect(parseWorkerRequest(new Request("https://worker.example/internal/images/ingest", { method: "POST" }))).rejects.toThrow("invalid_request");
  });

  it("rejects an advertised body larger than 1024 bytes before parsing", async () => {
    const payload = request({ gameId: 1, write: false }, { "Content-Length": "1025" });
    await expect(parseWorkerRequest(payload)).rejects.toThrow("invalid_request");
  });

  it("accepts a valid JSON body whose encoded length is exactly 1024 bytes", async () => {
    const body = JSON.stringify({ gameId: 1, write: false });
    const exact = body + " ".repeat(1024 - body.length);
    expect(new TextEncoder().encode(exact).byteLength).toBe(1024);
    await expect(parseWorkerRequest(request(exact))).resolves.toEqual({ gameId: 1, write: false });
  });

  it("rejects more than 1024 bytes when Content-Length is absent", async () => {
    const body = JSON.stringify({ gameId: 1, write: false, padding: "x".repeat(1100) });
    await expect(parseWorkerRequest(request(body))).rejects.toThrow("invalid_request");
  });

  it("cancels a stream that delivers one oversized chunk", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2048));
      },
      cancel() {
        canceled = true;
      },
    });
    const oversized = new Request("https://worker.example/internal/images/ingest", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(parseWorkerRequest(oversized)).rejects.toThrow("invalid_request");
    expect(canceled).toBe(true);
  });
});
