import { describe, expect, it, vi } from "vitest";
import { compareOwner, queryProcessIdentity } from "./process-identity";

const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: exec }));

describe("bounded OS process identity query", () => {
  it.each(["EPERM", "ENOENT", "timeout", "bad JSON", "invalid result"])("fails closed for %s", async (failure) => {
    exec.mockImplementation((_file, _args, options, callback) => {
      expect(options).toMatchObject({ timeout: 2000, killSignal: "SIGKILL", maxBuffer: 4096 });
      if (failure === "bad JSON") callback(null, "invalid", "");
      else if (failure === "invalid result") callback(null, '{"state":"present"}', "");
      else callback(new Error(failure));
    });
    await expect(queryProcessIdentity(123)).resolves.toEqual({ state: "unknown" });
  });
  it.each(["boot changed", "namespace changed"])("does not infer death across identity domains: %s", async (domain) => {
    await expect(compareOwner({ domain: "original", incarnation: "1" }, 123,
      async () => ({ state: "absent", domain }))).resolves.toBe("UNKNOWN");
  });
  it("distinguishes SAME_OWNER from confirmed replacement and absence", async () => {
    const identity = { domain: "same", incarnation: "first" };
    await expect(compareOwner(identity, 123, async () => ({ state: "present", ...identity }))).resolves.toBe("SAME_OWNER");
    await expect(compareOwner(identity, 123, async () => ({ state: "present", ...identity, incarnation: "second" }))).resolves.toBe("OWNER_GONE_OR_REPLACED");
    await expect(compareOwner(identity, 123, async () => ({ state: "absent", domain: "same" }))).resolves.toBe("OWNER_GONE_OR_REPLACED");
  });
});
