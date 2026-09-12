import { expect, expectTypeOf, it } from "vitest";
import { createSteamImporter } from "../importers/steam";
import { createIgdbEnricher } from "../enrichers/igdb";
import { createLinkVerificationService } from "../verifiers/official-links/service";
import { createImageIngestService } from "../images/service";
import { isStageError, stageError, type ImageWorkerClient, type IgdbEnricherPort, type LinkVerifierPort, type SteamImporterPort } from "./stages";

it("uses native stage signatures and plain stage errors", () => {
  expectTypeOf<ReturnType<typeof createSteamImporter>>().toExtend<SteamImporterPort>();
  expectTypeOf<ReturnType<typeof createIgdbEnricher>>().toExtend<IgdbEnricherPort>();
  expectTypeOf<ReturnType<typeof createLinkVerificationService>>().toExtend<LinkVerifierPort>();
  expectTypeOf<ReturnType<typeof createImageIngestService>>().toExtend<ImageWorkerClient>();

  const error = stageError("igdb", "mapping_ambiguous");
  expect(error).toEqual({
    stage: "igdb", code: "mapping_ambiguous",
    message: "Bulk sync igdb stage failed (mapping_ambiguous).",
  });
  expect(isStageError(error, "igdb")).toBe(true);
  expect(isStageError(new Error("secret"), "igdb")).toBe(false);
  expect(isStageError({ ...error, cause: "secret" }, "igdb")).toBe(false);
  expect(isStageError({ ...error, message: "caller text" }, "igdb")).toBe(false);

  const nonEnumerableExtra = { ...error } as Record<string, unknown>;
  Object.defineProperty(nonEnumerableExtra, "cause", { value: "secret", enumerable: false });
  expect(isStageError(nonEnumerableExtra, "igdb")).toBe(false);

  const symbolExtra = { ...error, [Symbol("cause")]: "secret" };
  expect(isStageError(symbolExtra, "igdb")).toBe(false);
  expect(isStageError(Object.create({ ...error }), "igdb")).toBe(false);
});

it("exports contracts without adapter factory ownership", async () => {
  const stageContracts = await import("./stages");
  expect(stageContracts).not.toHaveProperty("createSteamStage");
  expect(stageContracts).not.toHaveProperty("createIgdbStage");
  expect(stageContracts).not.toHaveProperty("createLinkStage");
  expect(stageContracts).not.toHaveProperty("createImageSyncStage");
});
