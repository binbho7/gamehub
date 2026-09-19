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
      const archive = join(root, "repository.tar");
      await exec("git", ["archive", "--format=tar", "HEAD", "-o", archive], { cwd: process.cwd() });
      await exec("tar", ["-xf", archive, "-C", root]);
      await exec("cp", ["-a", join(process.cwd(), "node_modules"), join(root, "node_modules")]);
      const { stdout } = await exec("git", ["ls-files", "generated/site-data.json", ".wrangler", ".env.local"], { cwd: process.cwd() });
      expect(stdout.trim()).toBe("generated/site-data.json");
      await exec("test", ["-f", "generated/site-data.json"], { cwd: root });
      await expect(exec("test", ["-e", ".env.local"], { cwd: root })).rejects.toThrow();
      await expect(exec("test", ["-e", ".wrangler"], { cwd: root })).rejects.toThrow();
      expect(await readFile(join(root, "generated/site-data.json"), "utf8")).toContain('"snapshotDate": "2026-09-19"');
      const { stdout: buildOutput } = await exec("npm", ["run", "build"], { cwd: root, env: { ...process.env, CI: "1" } });
      expect(buildOutput).toContain("Generating static pages");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
