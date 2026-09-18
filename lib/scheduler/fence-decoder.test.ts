import { describe, expect, it } from "vitest";
import { executeFencedBatch, type BuiltMutation } from "../db/repositories/scheduled/fence";
import { FenceLostError } from "./errors";
import { parseScheduledMutationAuthority } from "./types";

const authority = parseScheduledMutationAuthority({
  ownerToken: "11111111-1111-4111-8111-111111111111", fenceEpoch: 4, leaseExpiresAtMs: 1_500_000,
});
const mutation: BuiltMutation = { sql: "UPDATE genres SET name=? WHERE id=?", params: ["New", 1], minChanges: 1, maxChanges: 2 };

function result(changes: number, results: Record<string, unknown>[] = []): D1Result {
  return { success: true, results, meta: {
    changes, duration: 0, last_row_id: 0, changed_db: changes > 0, size_after: 0, rows_read: 0, rows_written: changes,
  } };
}
function assertion() { return result(1, [{ fence_epoch: 4 }]); }

// The D1 transport is replaced only to exercise malformed or failed responses
// that the local database cannot produce in a successful real transaction.
function bindingFor(outcome: D1Result[] | Error): D1Database {
  return {
    prepare() { return { bind() { return this; } }; },
    async batch() { if (outcome instanceof Error) throw outcome; return outcome; },
  } as unknown as D1Database;
}

describe("fenced batch result boundary", () => {
  it.each([0, 1, 2, 4])("rejects result cardinality %i for one mutation", async (count) => {
    await expect(executeFencedBatch(bindingFor(Array.from({ length: count }, assertion)), authority, [mutation]))
      .rejects.toThrow("cardinality");
  });

  it.each(["first", "last"])("rejects missing, duplicate or wrong epoch %s assertion rows", async (position) => {
    for (const rows of [[], [{ fence_epoch: 4 }, { fence_epoch: 4 }], [{ fence_epoch: 3 }], [{ fence_epoch: "4" }], [{}]]) {
      const results = [assertion(), result(1), assertion()];
      results[position === "first" ? 0 : 2] = result(1, rows);
      await expect(executeFencedBatch(bindingFor(results), authority, [mutation])).rejects.toBeInstanceOf(FenceLostError);
    }
  });

  it.each([-1, 0, 3, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects mutation changes %s outside integer bounds", async (changes) => {
    await expect(executeFencedBatch(bindingFor([assertion(), result(changes), assertion()]), authority, [mutation]))
      .rejects.toThrow("row count");
  });

  it.each([
    { minChanges: -1, maxChanges: 1 }, { minChanges: 1.5, maxChanges: 2 },
    { minChanges: 2, maxChanges: 1 }, { minChanges: 0, maxChanges: Infinity },
  ])("rejects invalid mutation bounds before sending the batch: %j", async (bounds) => {
    const neverExecute = new Error("The database must not receive invalid bounds");
    await expect(executeFencedBatch(bindingFor(neverExecute), authority, [{ ...mutation, ...bounds }]))
      .rejects.toThrow("Invalid fenced mutation bounds");
  });

  it("accepts inclusive and unbounded counts and returns only immutable mutation rows", async () => {
    const row = { id: 1, name: "New" };
    const output = await executeFencedBatch(bindingFor([
      assertion(), result(1, [row]), result(2), result(50), assertion(),
    ]), authority, [mutation, mutation, { ...mutation, maxChanges: null }]);
    expect(output.changes).toEqual([1, 2, 50]);
    expect(output.affectedRows).toBe(53);
    expect(output.results).toEqual([[{ id: 1, name: "New" }], [], []]);
    row.name = "Changed after decoding";
    expect(output.results[0][0].name).toBe("New");
    expect(Object.isFrozen(output.results)).toBe(true);
    expect(Object.isFrozen(output.results[0])).toBe(true);
    expect(Object.isFrozen(output.results[0][0])).toBe(true);
  });

  it("maps only the named epoch CHECK error to fence loss", async () => {
    await expect(executeFencedBatch(bindingFor(new Error("D1_ERROR: CHECK constraint failed: cron_sync_lease_epoch_check")), authority, [mutation]))
      .rejects.toBeInstanceOf(FenceLostError);
    for (const error of [new Error("CHECK constraint failed: unrelated_check"), new Error("database unavailable")]) {
      await expect(executeFencedBatch(bindingFor(error), authority, [mutation])).rejects.toBe(error);
    }
  });

  it.each([0, 1, 2])("rejects an unsuccessful D1 result at batch position %i", async (index) => {
    const results = [assertion(), result(1), assertion()];
    results[index] = { ...results[index], success: false, error: "query failed" } as unknown as D1Result;
    await expect(executeFencedBatch(bindingFor(results), authority, [mutation])).rejects.toThrow();
  });
});
