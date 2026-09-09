import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMAGE_INGEST_WORKER_URL,
  parseImageIngestArgs,
  runImageIngestCli,
} from "./ingest-images";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe("image ingest CLI argument parser", () => {
  it("defaults to the local Worker and dry-run", () => {
    expect(parseImageIngestArgs(["123"], env({ IMAGE_INGEST_TOKEN: "local-secret" }))).toEqual({
      gameId: 123,
      write: false,
      json: false,
      workerUrl: DEFAULT_IMAGE_INGEST_WORKER_URL,
      token: "local-secret",
    });
  });

  it("accepts write and JSON flags without changing the endpoint", () => {
    expect(parseImageIngestArgs(["123", "--write", "--json"], env({
      IMAGE_INGEST_TOKEN: "local-secret",
      IMAGE_INGEST_WORKER_URL: "http://127.0.0.1:8790",
    }))).toEqual({
      gameId: 123,
      write: true,
      json: true,
      workerUrl: "http://127.0.0.1:8790/internal/images/ingest",
      token: "local-secret",
    });
  });

  it("requires exactly one positive safe integer ID", () => {
    for (const argv of [[], ["1", "2"], ["0"], ["-1"], ["1.5"], ["nope"], ["https://example.test"]]) {
      expect(() => parseImageIngestArgs(argv, env({ IMAGE_INGEST_TOKEN: "secret" }))).toThrow();
    }
  });

  it("rejects duplicate and unknown flags", () => {
    for (const argv of [["1", "--write", "--write"], ["1", "--json", "--json"], ["1", "--force"]]) {
      expect(() => parseImageIngestArgs(argv, env({ IMAGE_INGEST_TOKEN: "secret" }))).toThrow();
    }
  });

  it("fails closed when the token is absent or empty", () => {
    expect(() => parseImageIngestArgs(["1"], env({}))).toThrow(/token/i);
    expect(() => parseImageIngestArgs(["1"], env({ IMAGE_INGEST_TOKEN: "" }))).toThrow(/token/i);
  });

  it("allows a production endpoint only when explicitly configured", () => {
    expect(parseImageIngestArgs(["1"], env({
      IMAGE_INGEST_WORKER_URL: "https://image-ingest.example.test/",
      IMAGE_INGEST_TOKEN: "production-secret",
    })).workerUrl).toBe("https://image-ingest.example.test/internal/images/ingest");

    expect(() => parseImageIngestArgs(["1"], env({
      IMAGE_INGEST_WORKER_URL: "https://image-ingest.example.test/",
    }))).toThrow(/token/i);
  });

  it("rejects endpoint credentials, query, fragment, and non-HTTP schemes", () => {
    for (const endpoint of [
      "https://user:password@example.test",
      "https://example.test?token=secret",
      "https://example.test/#fragment",
      "file:///tmp/worker",
    ]) {
      expect(() => parseImageIngestArgs(["1"], env({
        IMAGE_INGEST_WORKER_URL: endpoint,
        IMAGE_INGEST_TOKEN: "secret",
      }))).toThrow(/endpoint|worker URL|http/i);
    }
  });
});

describe("image ingest CLI HTTP client", () => {
  it("sends an authenticated dry-run request and prints sanitized JSON", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe("http://127.0.0.1:8787/internal/images/ingest");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer local-secret");
      expect(JSON.parse(String(init?.body))).toEqual({ gameId: 123, write: false });
      return new Response(JSON.stringify({
        gameId: 123,
        status: "completed",
        preflightError: null,
        images: [{ imageId: 4, outcome: "ingested", sourceUrl: "https://cdn.example.test/a?token=do-not-leak" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    await runImageIngestCli({
      gameId: 123,
      write: false,
      json: true,
      workerUrl: DEFAULT_IMAGE_INGEST_WORKER_URL,
      token: "local-secret",
    }, fetchImpl);

    expect(stdout).toHaveBeenCalledTimes(1);
    const output = String(stdout.mock.calls[0]?.[0]);
    expect(output).toContain('"status": "completed"');
    expect(output).not.toContain("do-not-leak");
    expect(output).not.toContain("local-secret");
    stdout.mockRestore();
  });

  it("sends write=true only when --write was selected", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ gameId: 7, write: true });
      return new Response(JSON.stringify({ gameId: 7, status: "completed", preflightError: null, images: [] }), { status: 200 });
    });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runImageIngestCli({
      gameId: 7,
      write: true,
      json: false,
      workerUrl: DEFAULT_IMAGE_INGEST_WORKER_URL,
      token: "secret",
    }, fetchImpl);

    expect(stdout.mock.calls.at(-1)?.[0]).toContain("Image ingest game 7: completed");
    stdout.mockRestore();
  });

  it("does not expose token or response details on HTTP failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: "internal_error", message: "https://example.test/?token=server-secret" } }),
      { status: 500 },
    ));
    await expect(runImageIngestCli({
      gameId: 7,
      write: false,
      json: true,
      workerUrl: DEFAULT_IMAGE_INGEST_WORKER_URL,
      token: "client-secret",
    }, fetchImpl)).rejects.toThrow(/Worker request failed/);
    await expect(runImageIngestCli({
      gameId: 7,
      write: false,
      json: false,
      workerUrl: DEFAULT_IMAGE_INGEST_WORKER_URL,
      token: "client-secret",
    }, fetchImpl)).rejects.toThrow(/Worker request failed/);
  });

  it("never provides a storage client or source downloader", async () => {
    const source = await import("node:fs");
    const cliSource = String(source.readFileSync(new URL("./ingest-images.ts", import.meta.url)));
    expect(cliSource).not.toMatch(/createDatabase|R2Bucket|wrangler|steamstatic|images\.igdb/);
  });
});
