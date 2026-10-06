import { many, one } from '@gitknot/core';
import type { EventRecord } from '@gitknot/core';
import { EVENT_RPC_SCOPE } from './event-routing.ts';
import type { CommittedEvent } from './event-routing.ts';
import { backgroundCell, shardEnvironment } from './placement.ts';
import { privateJSON } from './private.ts';
import type { OperationsBindings } from './types.ts';

export interface ReplaySource { replay_id: string; repo_id: string; cell_id: string; shard_id: string; cursor: string | null }
export interface ReplayPage { items: CommittedEvent[]; complete: boolean }

/** The captured physical source preserves rowid boundaries across metadata copies. */
export async function readReplayPage(env: OperationsBindings, source: ReplaySource): Promise<ReplayPage> {
  if (source.cell_id !== env.CELL_ID) return privateJSON<ReplayPage>(env, backgroundCell(env, source.cell_id), EVENT_RPC_SCOPE, '/internal/events/replay-page', source);
  const local = shardEnvironment(env, source.shard_id);
  const replay = await one<{ since_at: string; until_at: string; through_rowid: number }>(local.DB.withSession('first-primary'),
    'SELECT since_at,until_at,through_rowid FROM event_replays WHERE id=? AND repo_id=?', source.replay_id, source.repo_id);
  if (!replay) throw new Error('replay_source_missing');
  const rows = await many<{ id: string; event_json: string; created_at: string }>(local.DB,
    `SELECT id,event_json,created_at FROM outbox WHERE repo_id=? AND created_at>=? AND created_at<=? AND id>? AND rowid<=? ORDER BY id LIMIT 20`,
    source.repo_id, replay.since_at, replay.until_at, source.cursor ?? '', replay.through_rowid);
  return { items: rows.map(row => ({ event_id: row.id, cell_id: source.cell_id, shard_id: source.shard_id,
    event: JSON.parse(row.event_json) as EventRecord, created_at: row.created_at })), complete: rows.length < 20 };
}
