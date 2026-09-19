import { expect, it, vi } from "vitest";
import type { SteamImportResult } from "../../importers/candidate";
import type { IgdbEnrichmentResult } from "../../enrichers/igdb-candidate";
import type { GameLinkVerificationResult } from "../../verifiers/official-links/types";
import type { ImageResult } from "../../images/types";
import { createPipelineStagePorts } from "./adapters";

it("adapts existing domain ports and preserves idempotent image success", async () => {
  const ports = createPipelineStagePorts({
    steam: { importGame: vi.fn(async () => ({ appId: "7", gameId: 42, status: "existing", dryRun: false, plan: { action: "existing", existingGameId: 42 } } as unknown as SteamImportResult)) },
    igdb: { enrichGame: vi.fn(async () => ({ gameId: 42, status: "existing", dryRun: false, plan: { action: "existing", gameId: 42 }, affectedRows: 0 } as unknown as IgdbEnrichmentResult)) },
    links: { verifyGame: vi.fn(async () => ({ gameId: 42, status: "no_changes", dryRun: false, conflicts: [], affectedRows: 0, plan: { gameId: 42, dryRun: false, items: [], verificationResults: [] } } as unknown as GameLinkVerificationResult)) },
    images: { ingest: vi.fn(async () => ({ gameId: 42, status: "completed", preflightError: null, plan: null, images: [{ outcome: "already_ingested" }] } as unknown as ImageResult)) },
  });

  await expect(ports.import({ steamAppId: "7", gameId: null, dryRun: false })).resolves.toMatchObject({ stage: "import", gameId: 42 });
  await expect(ports.enrich({ steamAppId: "7", gameId: 42, dryRun: false })).resolves.toMatchObject({ stage: "enrich" });
  await expect(ports.verify({ steamAppId: "7", gameId: 42, dryRun: false })).resolves.toMatchObject({ stage: "verify" });
  await expect(ports.images({ steamAppId: "7", gameId: 42, dryRun: false })).resolves.toMatchObject({ stage: "images" });
});

it("blocks evaluation when no evaluator is configured", async () => {
  const ports = createPipelineStagePorts({
    steam: { importGame: vi.fn() },
    igdb: { enrichGame: vi.fn() },
    links: { verifyGame: vi.fn() },
    images: { ingest: vi.fn() },
  });

  await expect(ports.evaluate({ steamAppId: "7", gameId: 42, dryRun: true }))
    .rejects.toMatchObject({ stage: "evaluate", code: "evaluation_runtime_unavailable" });
});
