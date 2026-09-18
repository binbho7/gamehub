import { z } from "zod";
import { FenceLostError, safeCronError } from "../../../scheduler/errors";
import {
  parseScheduledMutationAuthority,
  type AttemptStamp,
  type SchedulerStateRepository,
  type ScheduledMutationAuthority,
} from "../../../scheduler/types";
import { executeFencedBatch } from "./fence";

const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const gameIdSchema = z.number().int().positive().safe();
const statusSchema = z.enum(["succeeded", "failed"]);

function asStamp(
  gameId: number,
  authority: ScheduledMutationAuthority,
  row: Record<string, unknown> | undefined,
): AttemptStamp {
  if (!row || row.game_id !== gameId || row.last_status !== "started") {
    throw safeCronError("state_write_failed");
  }
  if (!Number.isSafeInteger(row.last_attempt_at) || Number(row.last_attempt_at) < 0) {
    throw safeCronError("state_write_failed");
  }
  return {
    gameId,
    attemptedAt: new Date(row.last_attempt_at as number),
    authority,
  };
}

export function createSchedulerStateRepository(binding: D1Database): SchedulerStateRepository {
  return {
    async startAttempt(gameId, authority) {
      const id = gameIdSchema.parse(gameId);
      const captured = parseScheduledMutationAuthority(authority);
      try {
        const result = await executeFencedBatch(binding, captured, [{
          sql: `
            INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status)
            SELECT ?1,${DB_NOW},'started'
            WHERE EXISTS (SELECT 1 FROM games WHERE id=?1)
              AND EXISTS (
                SELECT 1 FROM cron_sync_lease
                WHERE name='game-sync'
                  AND lease_owner_token=?2
                  AND fence_epoch=?3
                  AND lease_expires_at>${DB_NOW}
              )
            ON CONFLICT(game_id) DO UPDATE SET
              last_attempt_at=excluded.last_attempt_at,
              last_status='started'
            WHERE EXISTS (
              SELECT 1 FROM cron_sync_lease
              WHERE name='game-sync'
                AND lease_owner_token=?2
                AND fence_epoch=?3
                AND lease_expires_at>${DB_NOW}
            )
            RETURNING game_id,last_attempt_at,last_status
          `.trim(),
          params: [id, captured.ownerToken, captured.fenceEpoch],
          minChanges: 0,
          maxChanges: 1,
        }]);
        return asStamp(id, captured, result.results[0]?.[0]);
      } catch (error) {
        if (error instanceof FenceLostError) throw error;
        if (error && typeof error === "object" && "code" in error && error.code === "state_write_failed") {
          throw error;
        }
        throw safeCronError("state_write_failed");
      }
    },

    async finishAttempt(stamp, status) {
      const id = gameIdSchema.parse(stamp.gameId);
      const captured = parseScheduledMutationAuthority(stamp.authority);
      const outcome = statusSchema.parse(status);
      const attemptedAt = stamp.attemptedAt.valueOf();
      if (!Number.isSafeInteger(attemptedAt) || attemptedAt < 0) {
        throw safeCronError("state_write_failed");
      }
      try {
        const result = await executeFencedBatch(binding, captured, [{
          sql: `
            UPDATE game_cron_sync_state
            SET last_status=?1
            WHERE game_id=?2
              AND last_attempt_at=?3
              AND last_status='started'
              AND EXISTS (
                SELECT 1 FROM cron_sync_lease
                WHERE name='game-sync'
                  AND lease_owner_token=?4
                  AND fence_epoch=?5
                  AND lease_expires_at>${DB_NOW}
              )
            RETURNING game_id,last_attempt_at,last_status
          `.trim(),
          params: [outcome, id, attemptedAt, captured.ownerToken, captured.fenceEpoch],
          minChanges: 0,
          maxChanges: 1,
        }]);
        if (result.changes[0] === 0) throw safeCronError("state_conflict");
        const row = result.results[0]?.[0];
        if (!row || row.game_id !== id || row.last_status !== outcome || row.last_attempt_at !== attemptedAt) {
          throw safeCronError("state_write_failed");
        }
      } catch (error) {
        if (error instanceof FenceLostError) throw error;
        if (error && typeof error === "object" && "code" in error) {
          const code = (error as { code: unknown }).code;
          if (code === "state_conflict" || code === "state_write_failed") throw error;
        }
        throw safeCronError("state_write_failed");
      }
    },
  };
}
