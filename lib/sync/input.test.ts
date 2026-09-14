import { expect, it, vi } from "vitest";
import { publicError } from "./errors";
import { normalizeBulkSyncAppIds, parseBulkSyncArgs } from "./input";

function expectConfigurationError(action: () => unknown) {
  try {
    action();
    throw new Error("expected configuration error");
  } catch (error) {
    expect(error).toEqual(publicError("configuration_error"));
  }
}

it("expands files in argv order and deduplicates after normalization", () => {
  const read = vi.fn(() => "20\n010\n");
  expect(parseBulkSyncArgs(["10", "--file", "ids.txt", "30"], read))
    .toEqual({ appIds: ["10", "20", "30"], write: false, json: false });
  expect(read).toHaveBeenCalledWith("ids.txt", "utf8");
});

it("accepts exactly 100 and rejects 101 unique after dedupe", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => String(i + 1));
  expect(parseBulkSyncArgs(hundred, () => "").appIds).toHaveLength(100);
  expect(() => parseBulkSyncArgs([...hundred, "101"], () => ""))
    .toThrow();
  expect(parseBulkSyncArgs([...hundred, "001"], () => "").appIds)
    .toHaveLength(100);
});

it("treats file flags as invalid App IDs", () => {
  expectConfigurationError(() => parseBulkSyncArgs(["--file", "ids.txt"], () => "--write\n"));
});

it("trims file lines and ignores comments", () => {
  expect(parseBulkSyncArgs(["--file", "ids.txt"], () => "  10\r\n# comment\r\n\t20  \r\n\r\n"))
    .toEqual({ appIds: ["10", "20"], write: false, json: false });
});

it("rejects an empty input before composition", () => {
  expectConfigurationError(() => parseBulkSyncArgs([], () => ""));
});

it.each(["0", "-1", "1.5", "NaN", "4294967296", "9007199254740993"])(
  "rejects invalid input before composition: %s",
  (value) => expectConfigurationError(() => parseBulkSyncArgs([value], () => "")),
);

it.each([
  ["duplicate --write", ["--write", "--write"]],
  ["duplicate --json", ["--json", "--json"]],
  ["duplicate --file", ["--file", "a", "--file", "b"]],
  ["absent file argument", ["--file"]],
  ["read failure", ["--file", "ids.txt"]],
  ["--remote", ["--remote"]],
  ["--env", ["--env"]],
  ["--config", ["--config"]],
  ["--database-id", ["--database-id"]],
  ["unknown flag", ["--unknown"]],
] as const)("rejects invalid input before composition: $0", (_name, argv) => {
  const read = _name === "read failure" ? () => { throw new Error("no read"); } : () => "1";
  expectConfigurationError(() => parseBulkSyncArgs(argv, read));
});

it("preserves write and json flags", () => {
  expect(parseBulkSyncArgs(["--write", "--json", "42"], () => ""))
    .toEqual({ appIds: ["42"], write: true, json: true });
});

it("normalizes and bounds direct app ID values", () => {
  expect(normalizeBulkSyncAppIds(["001", "1", "4294967295"]))
    .toEqual(["1", "4294967295"]);
  expectConfigurationError(() => normalizeBulkSyncAppIds([]));
});
