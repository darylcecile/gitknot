import { auditStatement, eventStatement, one, sha256, stmt } from '@gitknot/core';
import type { Database } from '@gitknot/core';
import { invariant } from './errors.ts';
import type { BillingStore, Budget, Journal, LedgerEntry, Reservation, StorageObject, UsageRollup } from './types.ts';
import type { CanonicalGitMeter, CanonicalGitReservation, HelperReservation } from './git-types.ts';

function rollupStatement(db: Database, coordinator: string, r: UsageRollup): D1PreparedStatement {
  return stmt(db, `INSERT INTO billing_usage_rollups (coordinator_id,account_id,period,dimension,dimension_id,meter,operating_cost,quantity,amount_units,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(coordinator_id,account_id,period,dimension,dimension_id,meter,operating_cost) DO UPDATE SET
    quantity=excluded.quantity,amount_units=excluded.amount_units,revision=excluded.revision WHERE excluded.revision>billing_usage_rollups.revision`,
  coordinator, r.account_id, r.period, r.dimension, r.dimension_id, r.meter, r.operating_cost ? 1 : 0, r.quantity, r.amount_units, r.revision);
}

function budgetStatement(db: Database, b: Budget): D1PreparedStatement {
  return stmt(db, `INSERT INTO billing_budgets
    (id,account_id,scope,scope_id,limit_units,safety_buffer_units,settled_units,reserved_units,commitment_units,period_start,period_end,threshold_percentages_json,stopped,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET limit_units=excluded.limit_units,safety_buffer_units=excluded.safety_buffer_units,
    settled_units=excluded.settled_units,reserved_units=excluded.reserved_units,commitment_units=excluded.commitment_units,
    threshold_percentages_json=excluded.threshold_percentages_json,stopped=excluded.stopped,revision=excluded.revision WHERE excluded.revision>billing_budgets.revision`,
  b.id, b.account_id, b.scope, b.scope_id, b.limit_units, b.safety_buffer_units, b.settled_units, b.reserved_units, b.commitment_units,
  b.period_start, b.period_end, JSON.stringify(b.threshold_percentages), b.stopped ? 1 : 0, b.revision);
}

function reservationStatement(db: Database, coordinator: string, r: Reservation): D1PreparedStatement {
  const a = r.quote.attribution;
  return stmt(db, `INSERT INTO billing_reservations
    (id,coordinator_id,account_id,repo_id,attempt_id,generation,state,fence,maximum_charge_units,maximum_platform_units,body_json,revision,created_at,settled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(coordinator_id,id) DO UPDATE SET state=excluded.state,body_json=excluded.body_json,
    revision=excluded.revision,settled_at=excluded.settled_at WHERE excluded.revision>billing_reservations.revision`,
  r.id, coordinator, a.account_id, a.repo_id, a.attempt_id, a.generation, r.state, r.fence, r.quote.maximum_charge_units,
  r.quote.maximum_platform_units, JSON.stringify(r), r.revision, r.created_at, r.settled_at);
}

function objectStatement(db: Database, coordinator: string, object: StorageObject): D1PreparedStatement {
  return stmt(db, `INSERT INTO billing_storage_objects
    (id,coordinator_id,account_id,repo_id,reservation_id,object_key,bucket,state,bytes,commitment_units,retention_until,commitment_until,accrued_at,deleted_at,body_json,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(coordinator_id,id) DO UPDATE SET state=excluded.state,bytes=excluded.bytes,
    commitment_units=excluded.commitment_units,accrued_at=excluded.accrued_at,deleted_at=excluded.deleted_at,body_json=excluded.body_json,
    revision=excluded.revision WHERE excluded.revision>billing_storage_objects.revision`,
  object.id, coordinator, object.account_id, object.attribution.repo_id, object.reservation_id, object.key, object.bucket,
  object.state, object.bytes, object.commitment_units, object.retention_until, object.commitment_until, object.accrued_at,
  object.deleted_at, JSON.stringify(object), object.revision);
}

function ledgerStatement(db: Database, e: LedgerEntry): D1PreparedStatement {
  return stmt(db, `INSERT INTO billing_ledger
    (id,event_id,account_id,repo_id,actor_id,workflow_id,team_id,run_id,attempt_id,generation,reservation_id,object_id,kind,operating_cost,quantity,amount_units,currency,
    price_id,price_version,meter,meter_version,unit_price_units,unit_quantity,remainder_before,remainder_after,closing_remainder_before,closing_remainder_after,occurred_at,recorded_at,evidence_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  e.id, e.event_id, e.account_id, e.repo_id, e.actor_id, e.workflow_id, e.team_id, e.run_id, e.attempt_id, e.generation, e.reservation_id,
  e.object_id, e.kind, e.operating_cost ? 1 : 0, e.quantity, e.amount_units, e.currency, e.price_id, e.price_version, e.meter,
  e.meter_version, e.unit_price_units, e.unit_quantity, e.remainder_before, e.remainder_after, e.closing_remainder_before ?? null,
  e.closing_remainder_after ?? null, e.occurred_at, e.recorded_at, e.evidence_id);
}

function helperStatement(db: Database, helper: HelperReservation): D1PreparedStatement {
  return stmt(db, `INSERT INTO billing_helper_allocations(reservation_id,allocation_id,slice_id,state,body_json,revision,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(reservation_id) DO UPDATE SET state=excluded.state,body_json=excluded.body_json,revision=excluded.revision,updated_at=excluded.updated_at
    WHERE excluded.revision>billing_helper_allocations.revision`, helper.reservation_id, helper.input.allocation_id, helper.slice_id,
  helper.state, JSON.stringify(helper), helper.revision, helper.settled_at ?? helper.started_at ?? helper.created_at);
}

function gitOperationStatement(db: Database, coordinator: string, operation: CanonicalGitReservation): D1PreparedStatement {
  const i = operation.input;
  return stmt(db, `INSERT INTO billing_git_operations(coordinator_id,reservation_id,account_id,repo_id,operation_id,state,body_json,revision,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(coordinator_id,reservation_id) DO UPDATE SET state=excluded.state,body_json=excluded.body_json,revision=excluded.revision,updated_at=excluded.updated_at
    WHERE excluded.revision>billing_git_operations.revision`, coordinator, operation.reservation_id, i.account_id, i.repo_id, i.operation_id,
  operation.state, JSON.stringify(operation), operation.revision, operation.verified_at ?? operation.created_at);
}

function gitMeterStatement(db: Database, coordinator: string, meter: CanonicalGitMeter): D1PreparedStatement {
  return stmt(db, `INSERT INTO billing_git_repositories(coordinator_id,id,account_id,repo_id,storage_name,logical_bytes,retained_bound_bytes,funded_until,accrued_at,body_json,revision)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(coordinator_id,id) DO UPDATE SET account_id=excluded.account_id,logical_bytes=excluded.logical_bytes,
    retained_bound_bytes=excluded.retained_bound_bytes,funded_until=excluded.funded_until,accrued_at=excluded.accrued_at,body_json=excluded.body_json,revision=excluded.revision
    WHERE excluded.revision>billing_git_repositories.revision`, coordinator, meter.id, meter.account_id, meter.repo_id, meter.storage_name,
  meter.logical_bytes, meter.retained_bound_bytes, meter.funded_until, meter.accrued_at, JSON.stringify(meter), meter.revision);
}

async function publish(db: Database, journal: Journal): Promise<void> {
  const hash = await sha256(JSON.stringify(journal));
  const existing = await one<{ payload_hash: string }>(db, 'SELECT payload_hash FROM billing_coordinator_events WHERE id=?', journal.id);
  if (existing) {
    invariant(existing.payload_hash === hash, 'billing_journal_conflict', 'Financial journal integrity requires reconciliation.', 503);
    return;
  }
  const statements = [
    stmt(db, 'INSERT INTO billing_coordinator_events (id,coordinator_id,sequence,payload_hash,created_at) VALUES (?,?,?,?,?)',
      journal.id, journal.coordinator_id, journal.sequence, hash, journal.created_at),
    stmt(db, `INSERT INTO billing_controls (coordinator_id,revision,body_json,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(coordinator_id) DO UPDATE SET revision=excluded.revision,body_json=excluded.body_json,updated_at=excluded.updated_at
      WHERE excluded.revision>billing_controls.revision`, journal.coordinator_id, journal.control.revision, JSON.stringify(journal.control), journal.created_at),
    ...journal.budgets.map((budget) => budgetStatement(db, budget)),
    ...journal.ledger.map((entry) => ledgerStatement(db, entry)),
    ...journal.rollups.map((rollup) => rollupStatement(db, journal.coordinator_id, rollup)),
  ];
  if (journal.reservation) statements.push(reservationStatement(db, journal.coordinator_id, journal.reservation));
  if (journal.object) statements.push(objectStatement(db, journal.coordinator_id, journal.object));
  if (journal.helper) statements.push(helperStatement(db, journal.helper));
  if (journal.git_operation) statements.push(gitOperationStatement(db, journal.coordinator_id, journal.git_operation));
  if (journal.git_meters) statements.push(...journal.git_meters.map(meter => gitMeterStatement(db, journal.coordinator_id, meter)));
  if (journal.deletion_request) {
    const r = journal.deletion_request;
    statements.push(stmt(db, `INSERT INTO billing_storage_deletion_requests(id,account_id,repo_id,object_id,reservation_id,fence,reason,state,requested_at,delete_after,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision WHERE excluded.revision>billing_storage_deletion_requests.revision`,
    r.id, r.account_id, r.repo_id, r.object_id, r.reservation_id, r.fence, r.reason, r.state, r.requested_at, r.delete_after, r.revision));
  }
  const a = journal.reservation?.quote.attribution ?? journal.object?.attribution ?? journal.git_meters?.[0]?.attribution ?? journal.git_operation?.input;
  if (journal.control.kind === 'account') {
    statements.push(eventStatement(db, {
      id: `evt:${journal.id}`, type: journal.event_type, occurred_at: journal.created_at,
      account_id: journal.control.account_id, repo_id: a?.repo_id, actor_id: a?.actor_id,
      resource_id: journal.reservation?.id ?? journal.object?.id ?? journal.git_meters?.[0]?.repo_id ?? journal.git_operation?.input.repo_id ?? journal.coordinator_id, resource_revision: journal.control.revision,
      data: { reservation_id: journal.reservation?.id ?? journal.object?.reservation_id ?? null, object_id: journal.object?.id ?? null,
        ledger_ids: journal.ledger.map((e) => e.id), ...(journal.object ? { retention_until: journal.object.retention_until,
          funded_until: journal.object.funded_until ?? null, delete_after: journal.object.delete_after ?? null, renewal_policy: journal.object.renewal_policy ?? null,
           deletion_request_id: journal.object.deletion_request_id ?? null, source: journal.object.source ?? 'execution', fence: journal.object.fence } : {}),
        ...(journal.git_meters?.[0] ? { canonical_git: { meter_id: journal.git_meters[0].id, storage_name: journal.git_meters[0].storage_name,
          logical_bytes: journal.git_meters[0].logical_bytes, retained_bound_bytes: journal.git_meters[0].retained_bound_bytes, funded_until: journal.git_meters[0].funded_until,
          commitment_until: journal.git_meters[0].commitment_until, funding_failure_at: journal.git_meters[0].funding_failure_at,
          renewal_policy: journal.git_meters[0].renewal_policy } } : {}) },
    }));
  }
  statements.push(auditStatement(db, {
    id: `audit:${journal.id}`, action: journal.event_type, created_at: journal.created_at,
    account_id: journal.control.account_id, repo_id: journal.control.kind === 'account' ? a?.repo_id : null,
    actor_id: a?.actor_id, resource_id: journal.coordinator_id, resource_revision: journal.control.revision,
    details: { journal_id: journal.id, payload_hash: hash, ledger_ids: journal.ledger.map((e) => e.id) },
  }));
  try { await db.batch(statements); }
  catch (error) {
    const raced = await one<{ payload_hash: string }>(db, 'SELECT payload_hash FROM billing_coordinator_events WHERE id=?', journal.id);
    if (raced?.payload_hash === hash) return;
    throw error;
  }
}

/** Delete a DO journal entry only after its entire immutable D1 financial batch is visible. */
export async function flushBillingJournal(db: Database, store: BillingStore, limit = 256): Promise<number> {
  const entries = await store.list<Journal>({ prefix: 'journal:', limit: limit + 1 });
  let count = 0;
  for (const [key, journal] of entries) {
    if (count >= limit) break;
    await publish(db, journal);
    await store.delete(key);
    count += 1;
  }
  invariant(entries.size <= limit, 'billing_projection_backlog', 'Financial publication is catching up; retry admission.', 503);
  return count;
}
