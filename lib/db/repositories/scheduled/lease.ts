import { z } from "zod";
import { safeCronError } from "../../../scheduler/errors";
import { parseScheduledMutationAuthority, type LeaseRepository } from "../../../scheduler/types";

const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const MAX_INTEGER = Number.MAX_SAFE_INTEGER;
const ownerSchema = z.uuid();
const durationSchema = z.number().int().safe().positive();

type LeaseRow = {
  lease_owner_token: string | null;
  lease_expires_at: number;
  fence_epoch: number;
};

async function rows<T>(statement: D1PreparedStatement): Promise<T[]> {
  const result = await statement.all<T>();
  if (!result.success) throw new Error("D1 operation failed");
  return result.results;
}

function authorityFromRow(row: LeaseRow) {
  return parseScheduledMutationAuthority({
    ownerToken: row.lease_owner_token,
    fenceEpoch: row.fence_epoch,
    leaseExpiresAtMs: row.lease_expires_at,
  });
}

export function createLeaseRepository(binding: D1Database): LeaseRepository {
  // Direct D1 binding operations use the primary. In particular, the diagnostic
  // read must never use a replica or grant authority after an uncertain write.
  return {
    async acquire(ownerToken, durationMs) {
      try {
        const owner = ownerSchema.parse(ownerToken).toLowerCase();
        const duration = durationSchema.parse(durationMs);
        const acquired = await rows<LeaseRow>(binding.prepare(`
          UPDATE cron_sync_lease
          SET lease_owner_token=?1,
              lease_expires_at=${DB_NOW}+?2,
              fence_epoch=fence_epoch+1
          WHERE name='game-sync'
            AND lease_expires_at<=${DB_NOW}
            AND fence_epoch<9007199254740991
            AND ${DB_NOW}<=9007199254740991-?2
            AND (
              (lease_owner_token IS NULL AND lease_expires_at=0)
              OR (fence_epoch>0 AND lease_expires_at>0 AND (
                (
                  length(lease_owner_token)=36
                  AND substr(lease_owner_token,9,1)='-'
                  AND substr(lease_owner_token,14,1)='-'
                  AND substr(lease_owner_token,19,1)='-'
                  AND substr(lease_owner_token,24,1)='-'
                  AND length(replace(lease_owner_token,'-',''))=32
                  AND lower(replace(lease_owner_token,'-','')) NOT GLOB '*[^0-9a-f]*'
                  AND substr(lease_owner_token,15,1) GLOB '[1-8]'
                  AND lower(substr(lease_owner_token,20,1)) GLOB '[89ab]'
                )
                OR lease_owner_token IN (
                  '00000000-0000-0000-0000-000000000000',
                  'ffffffff-ffff-ffff-ffff-ffffffffffff'
                )
              ))
            )
          RETURNING lease_owner_token,fence_epoch,lease_expires_at
        `).bind(owner, duration));
        if (acquired.length === 1) {
          const lease = authorityFromRow(acquired[0]);
          if (lease.ownerToken !== owner) throw new Error("Invalid acquisition response");
          return { status: "acquired", lease };
        }
        if (acquired.length !== 0) throw new Error("Invalid acquisition cardinality");

        const diagnostic = await rows<LeaseRow & { db_now_ms: number }>(binding.prepare(`
          SELECT lease_owner_token,fence_epoch,lease_expires_at,${DB_NOW} AS db_now_ms
          FROM cron_sync_lease WHERE name='game-sync'
        `));
        if (diagnostic.length !== 1) throw new Error("Missing singleton");
        const current = diagnostic[0];
        const lease = authorityFromRow(current);
        if (!Number.isSafeInteger(current.db_now_ms) || current.db_now_ms <= 0
          || current.fence_epoch >= MAX_INTEGER
          || duration > MAX_INTEGER - current.db_now_ms
          || lease.leaseExpiresAtMs <= current.db_now_ms) {
          throw new Error("Unavailable lease state");
        }
        return { status: "held" };
      } catch {
        // A committed acquire whose response is lost stays occupied until expiry.
        // Never recover a handle from the proposed token or retry the mutation.
        throw safeCronError("lease_acquire_failed");
      }
    },

    async assertOwned(lease) {
      try {
        const authority = parseScheduledMutationAuthority(lease);
        const owned = await rows<{ db_now_ms: number; lease_expires_at: number }>(binding.prepare(`
          SELECT ${DB_NOW} AS db_now_ms,lease_expires_at
          FROM cron_sync_lease
          WHERE name='game-sync' AND lease_owner_token=?1 AND fence_epoch=?2
            AND lease_expires_at>${DB_NOW}
        `).bind(authority.ownerToken, authority.fenceEpoch));
        if (owned.length !== 1) throw new Error("Lease no longer owned");
        const current = owned[0];
        if (!Number.isSafeInteger(current.db_now_ms) || current.db_now_ms <= 0
          || !Number.isSafeInteger(current.lease_expires_at)
          || current.lease_expires_at <= current.db_now_ms) {
          throw new Error("Invalid ownership response");
        }
        return { dbNowMs: current.db_now_ms, leaseExpiresAtMs: current.lease_expires_at };
      } catch {
        throw safeCronError("lease_lost");
      }
    },

    async release(lease) {
      try {
        const authority = parseScheduledMutationAuthority(lease);
        const released = await rows<{ fence_epoch: number }>(binding.prepare(`
          UPDATE cron_sync_lease SET lease_owner_token=NULL,lease_expires_at=0
          WHERE name='game-sync' AND lease_owner_token=?1 AND fence_epoch=?2
            AND lease_expires_at>${DB_NOW}
          RETURNING fence_epoch
        `).bind(authority.ownerToken, authority.fenceEpoch));
        if (released.length === 0) return "fence_lost";
        if (released.length !== 1 || released[0].fence_epoch !== authority.fenceEpoch) {
          throw new Error("Invalid release response");
        }
        return "released";
      } catch {
        throw safeCronError("lease_release_failed");
      }
    },
  };
}
