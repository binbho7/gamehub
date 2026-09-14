import { lookup as nodeLookup } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import type { AnyD1Database } from "drizzle-orm/d1";
import type { GetPlatformProxyOptions } from "wrangler";
import { createDatabase } from "../lib/db/client";
import { createIgdbEnrichmentStore } from "../lib/db/repositories/igdb-enrichment";
import { createLinkVerificationStore } from "../lib/db/repositories/link-verification";
import { createSteamImportStore } from "../lib/db/repositories/steam-import";
import { createIgdbEnricher } from "../lib/enrichers/igdb";
import { createSteamImporter } from "../lib/importers/steam";
import { createIgdbAuthClient } from "../lib/providers/igdb/auth-client";
import { createIgdbClient } from "../lib/providers/igdb/client";
import { createSteamClient } from "../lib/providers/steam/client";
import { publicError } from "../lib/sync/errors";
import { createIgdbStage } from "../lib/sync/igdb-stage";
import { createImageSyncStage } from "../lib/sync/image-stage";
import { createLinkStage } from "../lib/sync/link-stage";
import { createSteamStage } from "../lib/sync/steam-stage";
import type { BulkSyncStages } from "../lib/sync/stages";
import { createSafeDestinationResolver } from "../lib/verifiers/official-links/destination";
import { executeRedirectChain } from "../lib/verifiers/official-links/redirect";
import {
  createLinkVerificationService,
  type VerifyBoundUrl,
} from "../lib/verifiers/official-links/service";
import { requestHeaders } from "../lib/verifiers/official-links/transport";
import { verifyUrl } from "../lib/verifiers/official-links/verifier";
import { createImageWorkerClient } from "./sync-image-client";

const DEFAULT_WORKER_URL = "http://127.0.0.1:8787/internal/images/ingest";

export type BulkSyncConfig = {
  clientId: string;
  clientSecret: string;
  workerUrl: string;
  token: string;
};

export type LocalPlatform = {
  env: { DB: AnyD1Database };
  dispose(): Promise<void> | void;
};

export type BulkSyncDependencies = {
  stages: BulkSyncStages;
  dispose(): Promise<void>;
};

export type CompositionHooks = {
  acquire(): Promise<LocalPlatform>;
  compose(binding: AnyD1Database, config: BulkSyncConfig): BulkSyncStages;
};

export type BulkSyncTransportOverrides = {
  steamFetch?: typeof fetch;
  igdbFetch?: typeof fetch;
  authFetch?: typeof fetch;
  verifyBoundUrl?: VerifyBoundUrl;
  imageFetch?: typeof fetch;
};

function configurationError(): never {
  throw publicError("configuration_error");
}

function requireNonblank(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) return configurationError();
  return value;
}

function validateToken(value: string | undefined): string {
  if (value === undefined || value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    return configurationError();
  }
  return value;
}

function validateWorkerUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_WORKER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return configurationError();
  }
  if (
    url.protocol !== "http:"
    || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    || url.port !== "8787"
    || url.pathname !== "/internal/images/ingest"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    return configurationError();
  }
  return DEFAULT_WORKER_URL;
}

export function validateBulkSyncConfig(
  env: Readonly<Record<string, string | undefined>>,
): BulkSyncConfig {
  return {
    clientId: requireNonblank(env.TWITCH_CLIENT_ID),
    clientSecret: requireNonblank(env.TWITCH_CLIENT_SECRET),
    workerUrl: validateWorkerUrl(env.IMAGE_INGEST_WORKER_URL),
    token: validateToken(env.IMAGE_INGEST_TOKEN),
  };
}

function createLocalBoundVerifier(): VerifyBoundUrl {
  const resolveDestination = createSafeDestinationResolver({
    async lookup(hostname) {
      const addresses = await nodeLookup(hostname, { all: true });
      return addresses.map(({ address, family }) => {
        if (family !== 4 && family !== 6) throw new Error("Unsupported DNS family");
        return { address, family };
      });
    },
  });
  const executeChain = (url: string, method: "HEAD" | "GET", options?: {
    maxRedirects?: number;
    locationMaxLength?: number;
    signal?: AbortSignal;
  }) => executeRedirectChain(url, method, {
    resolveDestination,
    request: requestHeaders,
    now: () => new Date(),
  }, options);
  return (url, options) => verifyUrl(url, { executeChain }, options);
}

export function composeLocalBulkSyncStages(
  binding: AnyD1Database,
  config: BulkSyncConfig,
  ports: BulkSyncTransportOverrides = {},
): BulkSyncStages {
  const db = createDatabase(binding);
  const auth = createIgdbAuthClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    fetch: ports.authFetch,
  });
  return {
    steam: createSteamStage(createSteamImporter({
      client: createSteamClient({ fetch: ports.steamFetch }),
      store: createSteamImportStore(db),
    })),
    igdb: createIgdbStage(createIgdbEnricher({
      client: createIgdbClient({ auth, clientId: config.clientId, fetch: ports.igdbFetch }),
      store: createIgdbEnrichmentStore(db),
    })),
    links: createLinkStage(createLinkVerificationService({
      store: createLinkVerificationStore(db),
      verifyUrl: ports.verifyBoundUrl ?? createLocalBoundVerifier(),
    })),
    images: createImageSyncStage(createImageWorkerClient({
      workerUrl: config.workerUrl,
      token: config.token,
      fetchImpl: ports.imageFetch ?? fetch,
    })),
  };
}

const defaultCompositionHooks: CompositionHooks = {
  async acquire() {
    const { getPlatformProxy } = await import("wrangler");
    const options = {
      configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
      persist: { path: fileURLToPath(new URL("../.wrangler/state/v3", import.meta.url)) },
      remoteBindings: false,
      envFiles: [],
    } satisfies GetPlatformProxyOptions;
    return getPlatformProxy<{ DB: AnyD1Database }>(options);
  },
  compose: composeLocalBulkSyncStages,
};

export async function createLocalBulkSyncDependencies(
  config: BulkSyncConfig,
  hooks: CompositionHooks = defaultCompositionHooks,
): Promise<BulkSyncDependencies> {
  let platform: LocalPlatform;
  try {
    platform = await hooks.acquire();
  } catch {
    throw publicError("platform_unavailable");
  }
  try {
    const stages = hooks.compose(platform.env.DB, config);
    return {
      stages,
      dispose: async () => { await platform.dispose(); },
    };
  } catch {
    try {
      await platform.dispose();
    } catch {
      // Composition remains the primary public failure.
    }
    throw publicError("composition_failed");
  }
}
