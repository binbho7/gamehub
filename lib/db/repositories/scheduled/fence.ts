import { sql, type SQL } from "drizzle-orm";
import type { GameHubDatabase } from "../../client";
import { cronSyncLease } from "../../schema";
import { FenceLostError } from "../../../scheduler/errors";
import {
  parseScheduledMutationAuthority,
  type ScheduledMutationAuthority,
} from "../../../scheduler/types";

const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const FENCE_ASSERTION_SQL = `
UPDATE cron_sync_lease SET fence_epoch=CASE
 WHEN lease_owner_token=?1 AND fence_epoch=?2
  AND lease_expires_at>${DB_NOW}
 THEN fence_epoch ELSE -1 END
WHERE name='game-sync'
RETURNING fence_epoch
`.trim();

export type DomainBatchQuery = Parameters<GameHubDatabase["batch"]>[0][number];
export type BuiltMutation = {
  sql: string;
  params: unknown[];
  minChanges: number;
  maxChanges: number | null;
};
export type BuiltDomainQuery = BuiltMutation & { legacyQuery: DomainBatchQuery };
export type FencedBatchResult = {
  changes: number[];
  affectedRows: number;
  /** Mutation rows only; the two fence assertion rows are validated internally and omitted. */
  results: readonly ReadonlyArray<Record<string, unknown>>[];
};

type CompiledQuery = { sql: string; params: unknown[] };

function errorText(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function isNamedEpochCheckFailure(error: unknown) {
  return /cron_sync_lease_epoch_check/i.test(errorText(error));
}

function compileQuery(query: DomainBatchQuery): CompiledQuery {
  const candidate = query as { toSQL?: () => CompiledQuery; getQuery?: () => CompiledQuery };
  const compiled = candidate.toSQL?.() ?? candidate.getQuery?.();
  if (!compiled || typeof compiled.sql !== "string" || !Array.isArray(compiled.params)) {
    throw new Error("Domain query could not be compiled");
  }
  return { sql: compiled.sql, params: [...compiled.params] };
}

function requireBoundCounts(expected: { minChanges: number; maxChanges: number | null }) {
  if (!Number.isSafeInteger(expected.minChanges) || expected.minChanges < 0) {
    throw new Error("Invalid fenced mutation bounds");
  }
  if (expected.maxChanges !== null && (
    !Number.isSafeInteger(expected.maxChanges) || expected.maxChanges < expected.minChanges
  )) {
    throw new Error("Invalid fenced mutation bounds");
  }
}

function assertionStatement(binding: D1Database, authority: ScheduledMutationAuthority) {
  const captured = parseScheduledMutationAuthority(authority);
  return binding.prepare(FENCE_ASSERTION_SQL).bind(captured.ownerToken, captured.fenceEpoch);
}

function mutationStatement(binding: D1Database, mutation: BuiltMutation) {
  if (typeof mutation.sql !== "string" || mutation.sql.trim() === "") {
    throw new Error("Fenced mutation SQL is required");
  }
  requireBoundCounts(mutation);
  const statement = binding.prepare(mutation.sql);
  return mutation.params.length > 0 ? statement.bind(...mutation.params) : statement;
}

function assertionEpoch(result: D1Result, expectedEpoch: number) {
  if (result.results.length !== 1) throw new FenceLostError();
  const row = result.results[0] as { fence_epoch?: unknown };
  if (row.fence_epoch !== expectedEpoch) throw new FenceLostError();
}

function mutationRows(result: D1Result): ReadonlyArray<Record<string, unknown>> {
  return Object.freeze((result.results as Record<string, unknown>[]).map((row) => (
    Object.freeze({ ...row })
  )));
}

function validateMutationCounts(result: D1Result, mutation: BuiltMutation) {
  const changes = result.meta.changes;
  if (!Number.isSafeInteger(changes) || changes < mutation.minChanges) {
    throw new Error("Fenced mutation row count is invalid");
  }
  if (mutation.maxChanges !== null && changes > mutation.maxChanges) {
    throw new Error("Fenced mutation row count is invalid");
  }
  return changes;
}

export function fencePredicate(authority: ScheduledMutationAuthority): SQL {
  const captured = parseScheduledMutationAuthority(authority);
  return sql`exists (
    select 1 from ${cronSyncLease}
    where ${cronSyncLease.name} = 'game-sync'
      and ${cronSyncLease.leaseOwnerToken} = ${captured.ownerToken}
      and ${cronSyncLease.fenceEpoch} = ${captured.fenceEpoch}
      and ${cronSyncLease.leaseExpiresAt} > cast(unixepoch('subsec') * 1000 as integer)
  )`;
}

export function compileDomainQuery(
  query: DomainBatchQuery,
  expected: { minChanges: number; maxChanges: number | null },
): BuiltDomainQuery {
  requireBoundCounts(expected);
  const compiled = compileQuery(query);
  return {
    sql: compiled.sql,
    params: compiled.params,
    minChanges: expected.minChanges,
    maxChanges: expected.maxChanges,
    legacyQuery: query,
  };
}

export async function executeFencedBatch(
  binding: D1Database,
  authority: ScheduledMutationAuthority,
  mutations: readonly BuiltMutation[],
): Promise<FencedBatchResult> {
  const captured = parseScheduledMutationAuthority(authority);
  const statements = [
    assertionStatement(binding, captured),
    ...mutations.map((mutation) => mutationStatement(binding, mutation)),
    assertionStatement(binding, captured),
  ];

  let batchResults: D1Result[];
  try {
    batchResults = await binding.batch(statements);
  } catch (error) {
    if (isNamedEpochCheckFailure(error)) throw new FenceLostError();
    throw error;
  }

  if (batchResults.length !== mutations.length + 2) {
    throw new Error("Fenced batch result cardinality is invalid");
  }
  if (batchResults.some((result) => result.success !== true)) {
    throw new Error("Fenced batch returned an unsuccessful result");
  }

  assertionEpoch(batchResults[0], captured.fenceEpoch);
  assertionEpoch(batchResults[batchResults.length - 1], captured.fenceEpoch);

  const changes: number[] = [];
  const results: Array<ReadonlyArray<Record<string, unknown>>> = [];
  for (const [index, mutation] of mutations.entries()) {
    const result = batchResults[index + 1];
    changes.push(validateMutationCounts(result, mutation));
    results.push(mutationRows(result));
  }

  return {
    changes,
    affectedRows: changes.reduce((total, count) => total + count, 0),
    results: Object.freeze(results),
  };
}

export async function assertFence(
  binding: D1Database,
  authority: ScheduledMutationAuthority,
): Promise<void> {
  await executeFencedBatch(binding, authority, []);
}
