import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { publicError } from "../lib/sync/errors";
import type { BulkSyncStages } from "../lib/sync/stages";
import {
  composePipelineLocalStages,
  composeLocalBulkSyncStages,
  createLocalBulkSyncDependencies,
  validateBulkSyncConfig,
  validatePipelineProviderConfig,
} from "./sync-composition";

const stages = {} as BulkSyncStages;

describe("validateBulkSyncConfig", () => {
  const valid = {
    TWITCH_CLIENT_ID: " fixture-id ",
    TWITCH_CLIENT_SECRET: " fixture-secret ",
    IMAGE_INGEST_TOKEN: "fixture-token",
  };

  it("preserves exact Twitch credentials and defaults the local Worker endpoint", () => {
    expect(validateBulkSyncConfig(valid)).toEqual({
      clientId: " fixture-id ",
      clientSecret: " fixture-secret ",
      token: "fixture-token",
      workerUrl: "http://127.0.0.1:8787/internal/images/ingest",
    });
  });

  it("normalizes the only allowed localhost spelling", () => {
    expect(validateBulkSyncConfig({
      ...valid,
      IMAGE_INGEST_WORKER_URL: "http://localhost:8787/internal/images/ingest",
    }).workerUrl).toBe("http://127.0.0.1:8787/internal/images/ingest");
  });

  it("treats an unset or blank Worker URL as the fixed local endpoint", () => {
    expect(validateBulkSyncConfig({ ...valid, IMAGE_INGEST_WORKER_URL: "   " }).workerUrl)
      .toBe("http://127.0.0.1:8787/internal/images/ingest");
  });

  it.each([
    ["blank client id", { ...valid, TWITCH_CLIENT_ID: "  " }],
    ["blank client secret", { ...valid, TWITCH_CLIENT_SECRET: "" }],
    ["token whitespace", { ...valid, IMAGE_INGEST_TOKEN: "bad token" }],
    ["token leading whitespace", { ...valid, IMAGE_INGEST_TOKEN: " token" }],
    ["https", { ...valid, IMAGE_INGEST_WORKER_URL: "https://127.0.0.1:8787/internal/images/ingest" }],
    ["IPv6", { ...valid, IMAGE_INGEST_WORKER_URL: "http://[::1]:8787/internal/images/ingest" }],
    ["remote host", { ...valid, IMAGE_INGEST_WORKER_URL: "http://example.com:8787/internal/images/ingest" }],
    ["wrong port", { ...valid, IMAGE_INGEST_WORKER_URL: "http://127.0.0.1:8788/internal/images/ingest" }],
    ["wrong path", { ...valid, IMAGE_INGEST_WORKER_URL: "http://127.0.0.1:8787/other" }],
    ["credentials", { ...valid, IMAGE_INGEST_WORKER_URL: "http://user:pass@127.0.0.1:8787/internal/images/ingest" }],
    ["query", { ...valid, IMAGE_INGEST_WORKER_URL: "http://127.0.0.1:8787/internal/images/ingest?remote=true" }],
    ["fragment", { ...valid, IMAGE_INGEST_WORKER_URL: "http://127.0.0.1:8787/internal/images/ingest#x" }],
  ])("rejects unsafe or incomplete configuration: %s", (_name, env) => {
    expect(() => validateBulkSyncConfig(env)).toThrow();
    try {
      validateBulkSyncConfig(env);
    } catch (error) {
      expect(error).toEqual(publicError("configuration_error"));
      expect(JSON.stringify(error)).not.toContain("fixture-secret");
    }
  });
});

describe("createLocalBulkSyncDependencies", () => {
  it("validates all configuration before acquisition", async () => {
    const acquire = vi.fn();
    const createFromEnv = async (env: Readonly<Record<string, string | undefined>>) => (
      createLocalBulkSyncDependencies(validateBulkSyncConfig(env), {
        acquire,
        compose: vi.fn(),
      })
    );
    await expect(createFromEnv({})).rejects.toEqual(publicError("configuration_error"));
    expect(acquire).not.toHaveBeenCalled();
  });

  it("maps acquisition failure and transfers no disposal handle", async () => {
    const dispose = vi.fn();
    const acquire = vi.fn().mockRejectedValue(new Error("platform-secret"));
    const config = validateBulkSyncConfig({
      TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret", IMAGE_INGEST_TOKEN: "fixture-token",
    });
    await expect(createLocalBulkSyncDependencies(config, { acquire, compose: vi.fn() }))
      .rejects.toEqual(publicError("platform_unavailable"));
    expect(dispose).not.toHaveBeenCalled();
  });

  it("factory owns one disposal when composition and cleanup both fail", async () => {
    const dispose = vi.fn().mockRejectedValue(new Error("cleanup-secret"));
    const acquire = vi.fn().mockResolvedValue({ env: { DB: {} }, dispose });
    const compose = vi.fn(() => { throw new Error("compose-secret"); });
    const config = validateBulkSyncConfig({
      TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret",
      IMAGE_INGEST_TOKEN: "fixture-token",
    });
    await expect(createLocalBulkSyncDependencies(config, { acquire, compose }))
      .rejects.toEqual(publicError("composition_failed"));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("successful factory transfers disposal without invoking it", async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const binding = {};
    const acquire = vi.fn().mockResolvedValue({ env: { DB: binding }, dispose });
    const compose = vi.fn().mockReturnValue(stages);
    const config = validateBulkSyncConfig({
      TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret", IMAGE_INGEST_TOKEN: "fixture-token",
    });
    const dependencies = await createLocalBulkSyncDependencies(config, { acquire, compose });
    expect(compose).toHaveBeenCalledWith(binding, config);
    expect(dependencies.stages).toBe(stages);
    expect(dispose).not.toHaveBeenCalled();
    await dependencies.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("composeLocalBulkSyncStages", () => {
  it("constructs all four stages from one local D1 binding", () => {
    const binding = {} as never;
    const config = validateBulkSyncConfig({
      TWITCH_CLIENT_ID: "fixture-id",
      TWITCH_CLIENT_SECRET: "fixture-secret",
      IMAGE_INGEST_TOKEN: "fixture-token",
    });
    const noNetwork = vi.fn<typeof fetch>();
    const result = composeLocalBulkSyncStages(binding, config, {
      steamFetch: noNetwork,
      authFetch: noNetwork,
      igdbFetch: noNetwork,
      imageFetch: noNetwork,
      verifyBoundUrl: vi.fn(),
    });

    expect(Object.keys(result).sort()).toEqual(["igdb", "images", "links", "steam"]);
    expect(result.steam.execute).toEqual(expect.any(Function));
    expect(result.igdb.execute).toEqual(expect.any(Function));
    expect(result.links.execute).toEqual(expect.any(Function));
    expect(result.images.execute).toEqual(expect.any(Function));
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it("passes the database created from the binding to every local store", async () => {
    vi.resetModules();
    const binding = {};
    const database = {};
    const createDatabase = vi.fn(() => database);
    const createSteamImportStore = vi.fn(() => ({}));
    const createIgdbEnrichmentStore = vi.fn(() => ({}));
    const createLinkVerificationStore = vi.fn(() => ({}));
    vi.doMock("../lib/db/client", () => ({ createDatabase }));
    vi.doMock("../lib/db/repositories/steam-import", () => ({ createSteamImportStore }));
    vi.doMock("../lib/db/repositories/igdb-enrichment", () => ({ createIgdbEnrichmentStore }));
    vi.doMock("../lib/db/repositories/link-verification", () => ({ createLinkVerificationStore }));

    try {
      const composition = await import("./sync-composition");
      const config = composition.validateBulkSyncConfig({
        TWITCH_CLIENT_ID: "fixture-id",
        TWITCH_CLIENT_SECRET: "fixture-secret",
        IMAGE_INGEST_TOKEN: "fixture-token",
      });
      composition.composeLocalBulkSyncStages(binding as never, config, {
        verifyBoundUrl: vi.fn(),
      });
      expect(createDatabase).toHaveBeenCalledExactlyOnceWith(binding);
      expect(createSteamImportStore).toHaveBeenCalledExactlyOnceWith(database);
      expect(createIgdbEnrichmentStore).toHaveBeenCalledExactlyOnceWith(database);
      expect(createLinkVerificationStore).toHaveBeenCalledExactlyOnceWith(database);
    } finally {
      vi.doUnmock("../lib/db/client");
      vi.doUnmock("../lib/db/repositories/steam-import");
      vi.doUnmock("../lib/db/repositories/igdb-enrichment");
      vi.doUnmock("../lib/db/repositories/link-verification");
      vi.resetModules();
    }
  });

  it("acquires the fixed repository-local Wrangler platform", async () => {
    vi.resetModules();
    const dispose = vi.fn().mockResolvedValue(undefined);
    const getPlatformProxy = vi.fn().mockResolvedValue({ env: { DB: {} }, dispose });
    vi.doMock("wrangler", () => ({ getPlatformProxy }));

    try {
      const composition = await import("./sync-composition");
      const config = composition.validateBulkSyncConfig({
        TWITCH_CLIENT_ID: "fixture-id",
        TWITCH_CLIENT_SECRET: "fixture-secret",
        IMAGE_INGEST_TOKEN: "fixture-token",
      });
      const dependencies = await composition.createLocalBulkSyncDependencies(config);
      const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      expect(getPlatformProxy).toHaveBeenCalledExactlyOnceWith({
        configPath: resolve(repositoryRoot, "wrangler.jsonc"),
        persist: {
          path: resolve(repositoryRoot, ".wrangler/state/v3"),
        },
        remoteBindings: false,
        envFiles: [],
      });
      expect(dispose).not.toHaveBeenCalled();
      await dependencies.dispose();
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("wrangler");
      vi.resetModules();
    }
  });
});

describe("V2.10 pipeline single-platform composition", () => {
  it("requires only Twitch provider credentials", () => {
    expect(validatePipelineProviderConfig({
      TWITCH_CLIENT_ID: " fixture-id ",
      TWITCH_CLIENT_SECRET: " fixture-secret ",
    })).toEqual({
      clientId: " fixture-id ",
      clientSecret: " fixture-secret ",
    });
  });

  it.each([
    "https://images.example.com/images",
    "http://localhost:8788/images",
    "http://localhost:8787/other",
    "http://user:pass@localhost:8787/images",
  ])("rejects a non-local pipeline image publication base URL: %s", (baseUrl) => {
    expect(() => composePipelineLocalStages({
      DB: {} as never,
      IMAGES_BUCKET: {} as never,
      IMAGE_PUBLIC_BASE_URL: baseUrl,
    }, {
      clientId: "fixture-id",
      clientSecret: "fixture-secret",
    }, { verifyBoundUrl: vi.fn() })).toThrow();
  });

  it("passes one D1 database and the acquired R2 binding through every store", async () => {
    vi.resetModules();
    const binding = {};
    const bucket = {};
    const database = {};
    const imageRepository = {};
    const r2 = {};
    const imageService = { ingest: vi.fn().mockResolvedValue({ gameId: 7, status: "completed", preflightError: null, plan: null, images: [] }) };
    const createDatabase = vi.fn(() => database);
    const createSteamImportStore = vi.fn(() => ({}));
    const createIgdbEnrichmentStore = vi.fn(() => ({}));
    const createLinkVerificationStore = vi.fn(() => ({}));
    const createImageIngestRepository = vi.fn(() => imageRepository);
    const createR2ImageStore = vi.fn(() => r2);
    const createImageIngestService = vi.fn(() => imageService);
    const createImageWorkerClient = vi.fn(() => { throw new Error("HTTP image worker must not be composed"); });
    vi.doMock("../lib/db/client", () => ({ createDatabase }));
    vi.doMock("../lib/db/repositories/steam-import", () => ({ createSteamImportStore }));
    vi.doMock("../lib/db/repositories/igdb-enrichment", () => ({ createIgdbEnrichmentStore }));
    vi.doMock("../lib/db/repositories/link-verification", () => ({ createLinkVerificationStore }));
    vi.doMock("../lib/db/repositories/image-ingest", () => ({ createImageIngestRepository }));
    vi.doMock("../lib/images/r2-store", () => ({ createR2ImageStore }));
    vi.doMock("../lib/images/service", () => ({ createImageIngestService }));
    vi.doMock("./sync-image-client", () => ({ createImageWorkerClient }));

    try {
      const composition = await import("./sync-composition");
      const config = composition.validatePipelineProviderConfig({
        TWITCH_CLIENT_ID: "fixture-id",
        TWITCH_CLIENT_SECRET: "fixture-secret",
      });
      const result = composition.composePipelineLocalStages({
        DB: binding as never,
        IMAGES_BUCKET: bucket as never,
        IMAGE_PUBLIC_BASE_URL: "http://localhost:8787/images",
      }, config, { verifyBoundUrl: vi.fn() });

      expect(Object.keys(result).sort()).toEqual(["igdb", "images", "links", "steam"]);
      expect(createDatabase).toHaveBeenCalledExactlyOnceWith(binding);
      expect(createSteamImportStore).toHaveBeenCalledExactlyOnceWith(database);
      expect(createIgdbEnrichmentStore).toHaveBeenCalledExactlyOnceWith(database);
      expect(createLinkVerificationStore).toHaveBeenCalledExactlyOnceWith(database);
      expect(createImageIngestRepository).toHaveBeenCalledExactlyOnceWith(database);
      expect(createR2ImageStore).toHaveBeenCalledExactlyOnceWith(bucket, "http://localhost:8787/images");
      expect(createImageIngestService).toHaveBeenCalledWith(expect.objectContaining({ repository: imageRepository, r2 }));
      await expect(result.images.execute(7, { dryRun: false })).resolves.toEqual({ summary: "Images completed." });
      expect(imageService.ingest).toHaveBeenCalledExactlyOnceWith(7, { write: true });

      expect(createImageWorkerClient).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("../lib/db/client");
      vi.doUnmock("../lib/db/repositories/steam-import");
      vi.doUnmock("../lib/db/repositories/igdb-enrichment");
      vi.doUnmock("../lib/db/repositories/link-verification");
      vi.doUnmock("../lib/db/repositories/image-ingest");
      vi.doUnmock("../lib/images/r2-store");
      vi.doUnmock("../lib/images/service");
      vi.doUnmock("./sync-image-client");
      vi.resetModules();
    }
  });
});
