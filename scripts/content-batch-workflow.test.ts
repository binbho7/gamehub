import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("content batch workflow safety contract", () => {
  it("keeps provider build read-only and hands off one workspace-rooted bundle", async () => {
    const workflow = await readFile(resolve(".github/workflows/content-batch.yml"), "utf8");
    expect(workflow).toContain("permissions:\n      contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("mkdir -p \".automation-handoff/content/manifests\"");
    expect(workflow).toContain(".automation-handoff/summary.json");
    expect(workflow).toContain("name: content-batch-handoff");
    expect(workflow).toContain("path: .automation-handoff/");
    expect(workflow).not.toContain("/tmp/gamehub-content-batch-summary.json\n");
  });

  it("validates the handoff boundary and copies exactly the three approved outputs", async () => {
    const workflow = await readFile(resolve(".github/workflows/content-batch.yml"), "utf8");
    expect(workflow).toContain("path: .automation-download");
    expect(workflow).toContain("HANDOFF=.automation-download");
    expect(workflow).toContain("jq -r '.batchId'");
    expect(workflow).toContain("jq -r '.manifestPath'");
    expect(workflow).toContain("jq -r '.selectionPath'");
    expect(workflow).toContain("jq -r '.artifactPath'");
    expect(workflow).toContain("unexpected handoff path");
    expect(workflow).toContain('git add -- "content/manifests/${BATCH_ID}.json" "content/publication-selections/${BATCH_ID}.json" generated/site-data.json');
    expect(workflow).toContain('gh auth setup-git');
    expect(workflow).toContain('git push --set-upstream origin "$BRANCH_NAME"');
    expect(workflow).not.toContain("git push --set-upstream origin HEAD");
    expect(workflow).not.toContain("gh pr merge");
  });

  it("does not embed credentials in remote URLs or grant build write access", async () => {
    const workflow = await readFile(resolve(".github/workflows/content-batch.yml"), "utf8");
    expect(workflow).not.toMatch(/https?:\/\/[^\s]*@/);
    const buildJob = workflow.split("  open-pr:")[0];
    expect(buildJob).not.toContain("GH_TOKEN:");
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
  });
});
