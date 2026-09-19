import { describe, expect, it, vi } from "vitest";
import { composePipelineStages, type PipelineStageResult } from "./composition";

const success = (stage: PipelineStageResult["stage"], gameId = 42): PipelineStageResult => ({
  stage,
  status: "succeeded",
  gameId,
  summary: `${stage} ok`,
});

describe("V2.10 pipeline stage composition", () => {
  it("executes the exact discover-to-evaluate order", async () => {
    const calls: string[] = [];
    const pipeline = composePipelineStages({
      config: { execution: "local" },
      discover: async () => { calls.push("discover"); return success("discover"); },
      import: async () => { calls.push("import"); return success("import"); },
      enrich: async () => { calls.push("enrich"); return success("enrich"); },
      verify: async () => { calls.push("verify"); return success("verify"); },
      images: async () => { calls.push("images"); return success("images"); },
      evaluate: async () => { calls.push("evaluate"); return success("evaluate"); },
    });

    await expect(pipeline.run("1245620")).resolves.toMatchObject({ status: "succeeded" });
    expect(calls).toEqual(["discover", "import", "enrich", "verify", "images", "evaluate"]);
  });

  it("rejects malformed stage results before advancing", async () => {
    const evaluate = vi.fn(async () => success("evaluate"));
    const pipeline = composePipelineStages({
      config: { execution: "local" },
      discover: async () => success("discover"),
      import: async () => ({ stage: "import", status: "succeeded", gameId: 42, summary: "ok", extra: true } as never),
      enrich: async () => success("enrich"),
      verify: async () => success("verify"),
      images: async () => success("images"),
      evaluate,
    });

    await expect(pipeline.run("1245620")).rejects.toMatchObject({ code: "invalid_result", stage: "import" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("requires local execution and never accepts a production R2 path", () => {
    expect(() => composePipelineStages({
      config: { execution: "remote" as "local" },
      discover: async () => success("discover"), import: async () => success("import"),
      enrich: async () => success("enrich"), verify: async () => success("verify"),
      images: async () => success("images"), evaluate: async () => success("evaluate"),
    })).toThrow(/local/);

    expect(() => composePipelineStages({
      config: { execution: "local", productionR2: true },
      discover: async () => success("discover"), import: async () => success("import"),
      enrich: async () => success("enrich"), verify: async () => success("verify"),
      images: async () => success("images"), evaluate: async () => success("evaluate"),
    })).toThrow(/R2/);
  });

  it("treats idempotent_existing image results as success", async () => {
    const pipeline = composePipelineStages({
      config: { execution: "local" },
      discover: async () => success("discover"), import: async () => success("import"),
      enrich: async () => success("enrich"), verify: async () => success("verify"),
      images: async () => ({ stage: "images", status: "succeeded", gameId: 42, summary: "idempotent_existing" }),
      evaluate: async () => success("evaluate"),
    });
    await expect(pipeline.run("1245620")).resolves.toMatchObject({ status: "succeeded" });
  });
});
