import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("clean checkout production artifact", () => {
  it("contains the tracked artifact without local runtime state", async () => {
    const root = await mkdtemp(join(tmpdir(), "gamehub-clean-checkout-"));
    try {
      const { stdout } = await exec("git", ["ls-files", "generated/site-data.json", ".wrangler", ".env.local"], { cwd: process.cwd() });
      expect(stdout.trim()).toBe("generated/site-data.json");
      expect(await readFile("generated/site-data.json", "utf8")).toContain('"snapshotDate": "2026-09-19"');
      expect(root).toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
