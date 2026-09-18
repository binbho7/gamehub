import { z } from "zod";
import { normalizeSteamAppId } from "../../../providers/steam/app-id";
import type { CandidateRepository, SyncCandidate } from "../../../scheduler/types";
import { safeCronError } from "../../../scheduler/errors";

const limitSchema = z.number().int().min(1).max(25);
const gameIdSchema = z.number().int().positive().safe();

const ELIGIBLE_STEAM = `
WITH steam AS (
 SELECT game_id,MIN(external_id) AS app_id FROM game_external_ids
 WHERE provider='steam' GROUP BY game_id HAVING COUNT(*)=1
), eligible AS (
 SELECT g.id AS game_id,s.app_id FROM games g JOIN steam s ON s.game_id=g.id
 WHERE length(s.app_id) BETWEEN 1 AND 10
   AND s.app_id NOT GLOB '*[^0-9]*' AND substr(s.app_id,1,1) BETWEEN '1' AND '9'
   AND CAST(s.app_id AS INTEGER) BETWEEN 1 AND 4294967295
   AND CAST(CAST(s.app_id AS INTEGER) AS TEXT)=s.app_id
)
`;

function mapCandidate(row: { game_id: unknown; app_id: unknown }): SyncCandidate {
  const gameId = gameIdSchema.parse(row.game_id);
  const appId = normalizeSteamAppId(String(row.app_id));
  if (appId !== String(row.app_id)) throw new Error("Ineligible Steam App ID");
  return { gameId, appId };
}

export async function canonicalGameExists(binding: D1Database, gameId: number): Promise<boolean> {
  const id = gameIdSchema.parse(gameId);
  const row = await binding.prepare("SELECT 1 AS present FROM games WHERE id=?1").bind(id).first();
  return row != null;
}

export function createCandidateRepository(binding: D1Database): CandidateRepository {
  return {
    async select(limit) {
      try {
        const parsedLimit = limitSchema.parse(limit);
        const result = await binding.prepare(`
          ${ELIGIBLE_STEAM}
          SELECT e.game_id,e.app_id FROM eligible e
          LEFT JOIN game_cron_sync_state s ON s.game_id=e.game_id
          ORDER BY (s.last_attempt_at IS NOT NULL) ASC,s.last_attempt_at ASC,e.game_id ASC LIMIT ?1
        `).bind(parsedLimit).all<{ game_id: number; app_id: string }>();
        if (!result.success) throw new Error("Candidate query failed");
        return result.results.map(mapCandidate);
      } catch {
        throw safeCronError("candidate_read_failed");
      }
    },

    async stillMatches(candidate) {
      try {
        const gameId = gameIdSchema.parse(candidate.gameId);
        const appId = normalizeSteamAppId(candidate.appId);
        const row = await binding.prepare(`
          ${ELIGIBLE_STEAM}
          SELECT e.game_id,e.app_id FROM eligible e
          WHERE e.game_id=?1 AND e.app_id=?2
        `).bind(gameId, appId).first<{ game_id: number; app_id: string }>();
        if (!row) return false;
        const matched = mapCandidate(row);
        return matched.gameId === gameId && matched.appId === appId;
      } catch {
        throw safeCronError("candidate_read_failed");
      }
    },
  };
}
