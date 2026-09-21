import { describe, expect, it, vi } from "vitest";
import { OPERATOR_RECOVERY_CONFIRMATION } from "../lib/pipeline/publication-lock";
import { parseRecoveryArgs, runRecoveryCommand } from "./recover-publication-lock";

describe("publication lock operator recovery CLI", () => {
  it("rejects missing or partial confirmation", () => {
    expect(() => parseRecoveryArgs([])).toThrow("confirmation");
    expect(() => parseRecoveryArgs(["--confirm-all-exporters-stopped"])).toThrow("confirmation");
    expect(() => parseRecoveryArgs(["--confirmation", OPERATOR_RECOVERY_CONFIRMATION])).toThrow("confirmation");
  });

  it("accepts only the exact two-part confirmation and no path override", () => {
    expect(parseRecoveryArgs(["--confirm-all-exporters-stopped", "--confirmation", OPERATOR_RECOVERY_CONFIRMATION])).toEqual({ confirmed: true });
    expect(() => parseRecoveryArgs(["--confirm-all-exporters-stopped", "--confirmation", "yes"])).toThrow("confirmation");
    expect(() => parseRecoveryArgs(["--confirm-all-exporters-stopped", "--confirmation", OPERATOR_RECOVERY_CONFIRMATION, "--path", "/tmp/x"])).toThrow("unsupported");
  });

  it("operates only on the canonical artifact and prints sanitized status", async () => {
    const recover = vi.fn(async () => ({ generation: 7, status: "recovered" as const }));
    const stdout = vi.fn();
    await runRecoveryCommand({
      argv: ["--confirm-all-exporters-stopped", "--confirmation", OPERATOR_RECOVERY_CONFIRMATION],
      recover,
      stdout,
    });
    expect(recover).toHaveBeenCalledWith("generated/site-data.json", OPERATOR_RECOVERY_CONFIRMATION);
    expect(stdout).toHaveBeenCalledWith("publication lock generation 7 recovery completed\n");
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("owner");
  });
});
