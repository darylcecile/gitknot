import { eventStatement, execute, identityBinding, many, newId, now, one, registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { consumeOnce } from './durable.ts';
import { recordDiagnostic } from './private.ts';
import type { Operation, OperationsBindings } from './types.ts';
import { isIdentityPlacement, localRepository, placementGuard } from './ownership.ts';
import type { MoveControl } from './move-control.ts';
import { sameMovePlacement } from './move-control.ts';

export async function dispatchOperations(env: OperationsBindings): Promise<void> {
  const db = env.DB.withSession('first-primary');
  type DispatchOperation = Operation & { dispatch_attempts: number | null; next_attempt_at: string | null; dispatch_workflow_id: string | null };
  const operations = await many<DispatchOperation>(db,
    `SELECT o.*,d.attempts AS dispatch_attempts,d.next_attempt_at,d.workflow_id AS dispatch_workflow_id FROM operations o
      LEFT JOIN operation_dispatches d ON d.operation_id=o.id WHERE
      (o.status IN ('pending','waiting','running') OR (o.status='failed' AND json_extract(o.error_json,'$.retryable')=1))
       AND o.kind<>'events.replay' AND NOT (o.kind='repository.export' AND json_extract(o.input_json,'$.account_export_id') IS NOT NULL)
       AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?) AND COALESCE(d.attempts,0)<20 ORDER BY o.updated_at,o.id LIMIT 50`, now());
  const moves = await many<MoveControl>(identityBinding(env), `SELECT * FROM repository_move_controls WHERE source_cell_id=? AND source_shard_id=?
    AND state NOT IN ('completed','aborted') ORDER BY updated_at,operation_id LIMIT 25`, env.CELL_ID, env.SHARD_ID);
  const extra = moves.filter(move => !operations.some(operation => operation.id === move.operation_id));
  if (extra.length) operations.push(...await many<DispatchOperation>(db, `SELECT o.*,d.attempts AS dispatch_attempts,d.next_attempt_at,d.workflow_id AS dispatch_workflow_id
    FROM operations o LEFT JOIN operation_dispatches d ON d.operation_id=o.id WHERE o.kind='repository.move'
      AND o.id IN (SELECT value FROM json_each(?)) AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=?)`, JSON.stringify(extra.map(move => move.operation_id)), now()));
  for (const operation of operations) {
    const identityOwned = operation.kind === 'collaboration.code_scan' || operation.repo_id === null;
    const move = operation.kind === 'repository.move' ? await one<MoveControl>(identityBinding(env), 'SELECT * FROM repository_move_controls WHERE operation_id=?', operation.id) : null;
    if (move && (!sameMovePlacement(move, env, 'source') || ['completed', 'aborted'].includes(move.state))) continue;
    const repository = move ? await one<Repository>(db, 'SELECT * FROM repositories WHERE id=?', move.repo_id)
      : identityOwned ? null : await localRepository(env, operation.repo_id!, operation.id);
    if (identityOwned ? !isIdentityPlacement(env) : !repository) continue;
    await registerResourceLocator(env, { resource_id: operation.id, resource_type: 'operation', repo_id: identityOwned ? null : operation.repo_id });
    // Workflow runtime IDs are placement-specific; the public/native operation ID never changes.
    const workflowId = `oprun_${(await sha256(`${operation.id}:${env.CELL_ID}:${env.SHARD_ID}:${move?.source_epoch ?? repository?.routing_epoch ?? 0}`)).slice(0, 48)}`;
    await execute(db, `INSERT INTO operation_dispatches(operation_id,workflow_id,next_attempt_at) VALUES(?,?,?)
      ON CONFLICT(operation_id) DO UPDATE SET workflow_id=excluded.workflow_id,generation=generation+1,attempts=0,next_attempt_at=excluded.next_attempt_at
      WHERE operation_dispatches.workflow_id<>excluded.workflow_id`, operation.id, workflowId, now());
    try {
      let exists = false;
      let started = false;
      try {
        const instance = await env.OPERATIONS.get(workflowId);
        const status = await instance.status();
        exists = status.status !== 'unknown';
        if (status.status === 'errored' || status.status === 'terminated') { await instance.restart(); started = true; }
        else if (status.status === 'complete' && (operation.status !== 'completed' || move)) {
          // A Workflow instance may finish before its final catalog checkpoint is acknowledged.
          await instance.restart();
          started = true;
        }
      } catch (error) {
        if (!/not.found|does.not.exist|not exist/i.test(String(error))) throw error;
      }
      if (!exists) { await env.OPERATIONS.create({ id: workflowId, params: { operation_id: operation.id, shard_id: env.SHARD_ID, cell_id: env.CELL_ID } }); started = true; }
      await db.batch([
        stmt(db, `UPDATE operation_dispatches SET last_started_at=CASE WHEN ? THEN ? ELSE last_started_at END,next_attempt_at=?,attempts=attempts+?,error_code=NULL WHERE operation_id=?`,
          Number(started), now(), new Date(Date.now() + 5 * 60_000).toISOString(), Number(started), operation.id),
        stmt(db, `UPDATE operations SET workflow_id=? WHERE id=?`, workflowId, operation.id),
      ]);
    } catch (error) {
      await recordDiagnostic(env, 'operation-dispatch', operation.id, error);
      await execute(db, `UPDATE operation_dispatches SET next_attempt_at=?,attempts=attempts+1,error_code='dispatch_unavailable' WHERE operation_id=?`,
        new Date(Date.now() + Math.min(3600, 30 * 2 ** Math.min(operation.dispatch_attempts ?? 0, 7)) * 1000).toISOString(), operation.id);
    }
  }
}

export async function scheduleMaintenance(env: OperationsBindings): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const deletions = await many<{ id: string; owner_id: string; created_by: string; revision: number }>(db,
    `SELECT r.id,r.owner_id,r.created_by,r.revision FROM repositories r WHERE r.state='deleted' AND r.recovery_until<=?
      AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.repo_id=r.id AND o.kind='repository.purge' AND o.status<>'cancelled') ORDER BY r.id LIMIT 25`, now());
  for (const repo of deletions) {
    const current = await localRepository(env, repo.id);
    if (!current) continue;
    const id = `op_purge_${(await sha256(`${repo.id}:${repo.revision}`)).slice(0, 48)}`;
    await registerResourceLocator(env, { resource_id: id, resource_type: 'operation', repo_id: repo.id });
    await consumeOnce(db, 'repository-purge-schedule', repo.id, [
      ...placementGuard(db, current),
      stmt(db, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
        VALUES(?,'repository.purge',?,?,?,?,?,?,?)`, id, repo.id, repo.id, repo.owner_id, 'system:operations', JSON.stringify({ maintenance: true }), now(), now()),
      stmt(db, `INSERT INTO operations_maintenance_intents(operation_id,repo_id,account_id,purpose,authority_id,routing_epoch,repository_revision,created_at)
        VALUES(?,?,?,'repository.purge','svc_operations_maintenance',?,?,?)`, id, repo.id, repo.owner_id, current.routing_epoch, current.revision, now()),
      eventStatement(db, { type: 'operation.requested', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id, data: { kind: 'repository.purge' } }),
    ]);
  }
  const date = new Date().toISOString().slice(0, 10);
  const backups = await many<{ id: string; owner_id: string; created_by: string }>(db, `SELECT r.id,r.owner_id,r.created_by FROM repositories r
    WHERE r.state IN ('active','archived') AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.repo_id=r.id AND o.kind='repository.backup'
      AND o.created_at>=?) AND NOT EXISTS(SELECT 1 FROM repository_lifecycle l WHERE l.repo_id=r.id AND l.state IN ('queued','running','waiting'))
      ORDER BY r.id LIMIT 10`, `${date}T00:00:00.000Z`);
  for (const repo of backups) {
    const current = await localRepository(env, repo.id);
    if (!current) continue;
    const id = `op_backup_${(await sha256(`${repo.id}:${date}`)).slice(0, 48)}`;
    await registerResourceLocator(env, { resource_id: id, resource_type: 'operation', repo_id: repo.id });
    await consumeOnce(db, 'repository-backup-schedule', `${repo.id}:${date}`, [
      ...placementGuard(db, current),
      stmt(db, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
        VALUES(?,'repository.backup',?,?,?,?,?,?,?)`, id, repo.id, repo.id, repo.owner_id, 'system:operations', JSON.stringify({ maintenance: true }), now(), now()),
      stmt(db, `INSERT INTO operations_maintenance_intents(operation_id,repo_id,account_id,purpose,authority_id,routing_epoch,repository_revision,created_at)
        VALUES(?,?,?,'repository.backup','svc_operations_maintenance',?,?,?)`, id, repo.id, repo.owner_id, current.routing_epoch, current.revision, now()),
      eventStatement(db, { type: 'operation.requested', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id, data: { kind: 'repository.backup' } }),
    ]);
  }
}

export async function expireArchives(env: OperationsBindings): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const rows = await many<{ id: string; repo_id: string }>(db,
    `SELECT id,repo_id FROM repository_archives WHERE state='verified' AND expires_at<=? ORDER BY expires_at,id LIMIT 50`, now());
  for (const archive of rows) {
    const repository = await localRepository(env, archive.repo_id);
    if (!repository) continue;
    await consumeOnce(db, 'archive-expire', archive.id, [
      ...placementGuard(db, repository),
      stmt(db, `UPDATE object_manifests SET reference_count=MAX(0,reference_count-1),revision=revision+1,updated_at=?
        WHERE repo_id=? AND object_key IN (SELECT object_key FROM archive_parts WHERE archive_id=?) AND state='ready'`, now(), archive.repo_id, archive.id),
      stmt(db, `UPDATE repository_archives SET state='expired' WHERE id=? AND state='verified'`, archive.id),
      stmt(db, `UPDATE repository_exports SET state='expired',revision=revision+1 WHERE repo_id=? AND operation_id IN(SELECT operation_id FROM repository_archives WHERE id=?)`, archive.repo_id, archive.id),
    ]);
  }
}

export async function expireEventHistory(env: OperationsBindings): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  // D1 source retention is independent of Queue/DLQ retention. Pending work pins its source indefinitely.
  const events = await many<{ id: string }>(db, `SELECT o.id FROM outbox o WHERE o.created_at<? AND o.status='published'
    AND NOT EXISTS(SELECT 1 FROM event_publications p WHERE p.event_id=o.id AND p.expires_at>?)
    AND NOT EXISTS(SELECT 1 FROM event_source_links s WHERE s.event_id=o.id AND s.created_at>=?)
    AND (EXISTS(SELECT 1 FROM processed_events p WHERE p.event_id=o.id AND p.consumer='dispatcher')
      OR EXISTS(SELECT 1 FROM event_source_links s WHERE s.event_id=o.id AND s.imported=1))
    AND NOT EXISTS(SELECT 1 FROM event_consumer_jobs j WHERE j.event_id=o.id AND j.state<>'completed')
    AND NOT EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.event_id=o.id AND (d.state IN ('pending','sending') OR d.created_at>=?))
    AND NOT EXISTS(SELECT 1 FROM mail_deliveries m WHERE m.event_id=o.id AND (m.state IN ('pending','sending') OR m.created_at>=?))
    AND NOT EXISTS(SELECT 1 FROM collaboration_inbox i WHERE i.source_event_id=o.id)
    AND NOT EXISTS(SELECT 1 FROM event_replays r WHERE r.repo_id=o.repo_id AND r.state IN ('pending','running')
      AND (r.id=o.resource_id OR (o.created_at>=r.since_at AND o.created_at<=r.until_at AND o.rowid<=r.through_rowid)))
    ORDER BY o.created_at,o.id LIMIT 100`, cutoff, now(), cutoff, cutoff, cutoff);
  for (const event of events) {
    await db.batch([
      stmt(db, 'DELETE FROM webhook_attempts WHERE delivery_id IN(SELECT id FROM webhook_deliveries WHERE event_id=?)', event.id),
      stmt(db, 'DELETE FROM webhook_deliveries WHERE event_id=?', event.id),
      stmt(db, 'DELETE FROM mail_provider_events WHERE delivery_id IN(SELECT id FROM mail_deliveries WHERE event_id=?)', event.id),
      stmt(db, 'DELETE FROM mail_deliveries WHERE event_id=?', event.id),
      stmt(db, 'DELETE FROM processed_events WHERE consumer=?', `mail-recipient:${event.id}`),
      stmt(db, 'DELETE FROM mail_recipients WHERE event_id=?', event.id),
      stmt(db, 'DELETE FROM mail_fanouts WHERE event_id=?', event.id),
      stmt(db, 'DELETE FROM event_consumer_jobs WHERE event_id=?', event.id),
      stmt(db, 'DELETE FROM event_publications WHERE event_id=?', event.id),
        stmt(db, 'DELETE FROM processed_events WHERE event_id=?', event.id),
        stmt(db, 'DELETE FROM event_source_links WHERE event_id=?', event.id),
      stmt(db, 'DELETE FROM outbox WHERE id=?', event.id),
    ]);
  }
  await execute(db, 'DELETE FROM operations_diagnostics WHERE id IN(SELECT id FROM operations_diagnostics WHERE expires_at<=? LIMIT 500)', now());
  await execute(db, 'DELETE FROM internal_nonces WHERE expires_at<=?', now());
}
