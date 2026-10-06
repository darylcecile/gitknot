import {
  BillingError, cancelSeatReservation, ensureBillingAccount, previewSeatChange, reserveSeatChange, seatAcceptanceStatements,
} from '@gitknot/billing';
import {
  ApiError, auditStatement, eventStatement, newId, now, one, sha256, stmt,
} from '@gitknot/core';
import type { Bindings, Database } from '@gitknot/core';
import { condition, federationBatch, guarded, providerGuard } from './store.ts';
import type { Provider } from './types.ts';

export interface SeatSource {
  kind: 'flow' | 'scim' | 'membership'; id: string; generation: number; attempt_id: string; expires_at: string; actor_id: string;
}

interface MembershipSnapshot {
  membership_json: string | null;
  outside_seat: number;
}

interface Admission {
  id: string; account_id: string; provider_id: string; principal_id: string;
  source_kind: SeatSource['kind']; source_id: string; source_generation: number; source_attempt: string;
  request_json: string; request_hash: string; expected_billing_revision: number;
  reservation_id: string | null; state: 'preparing' | 'reserved' | 'consumed' | 'cancelling' | 'cancelled';
  expires_at: string; created_at: string;
}

export interface MembershipFinance {
  guards: D1PreparedStatement[];
  statements: D1PreparedStatement[];
  admission_id: string | null;
}

const activeGrant = `account_id=? AND principal_id=? AND principal_type='user' AND effect='allow'
  AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

function sourceGuard(db: Database, source: SeatSource): D1PreparedStatement[] {
  if (source.kind === 'scim') return condition(db, `EXISTS (SELECT 1 FROM federation_scim_requests WHERE id=? AND generation=?
    AND attempt_id=? AND committed_at IS NULL AND status IN ('pending','uncertain'))`, source.id, source.generation, source.attempt_id);
  if (source.kind === 'flow') return condition(db, `EXISTS (SELECT 1 FROM federation_auth_flows WHERE id=? AND consumed_at IS NOT NULL
    AND completed_at IS NULL AND expires_at>?)`, source.id, now());
  return [];
}

async function seatSnapshot(db: Database, accountId: string, principalId: string): Promise<{ occupied: boolean; guards: D1PreparedStatement[] }> {
  const snapshot = await one<MembershipSnapshot>(db, `SELECT (SELECT json_object('revision',revision,'state',state)
    FROM memberships WHERE account_id=? AND principal_id=?) AS membership_json,
    EXISTS (SELECT 1 FROM access_grants WHERE ${activeGrant}) AS outside_seat`, accountId, principalId, accountId, principalId);
  if (!snapshot) throw new ApiError(503, 'seat_state_unavailable', 'Organization seat state could not be verified.');
  const membership = snapshot.membership_json ? JSON.parse(snapshot.membership_json) as { revision: number; state: string } : null;
  return { occupied: membership?.state === 'active' || snapshot.outside_seat === 1, guards: [
    ...condition(db, membership ? 'EXISTS (SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND revision=?)'
      : 'NOT EXISTS (SELECT 1 FROM memberships WHERE account_id=? AND principal_id=?)', accountId, principalId, ...(membership ? [membership.revision] : [])),
    ...condition(db, `EXISTS (SELECT 1 FROM access_grants WHERE ${activeGrant})=?`, accountId, principalId, snapshot.outside_seat),
  ] };
}

async function reductionStatements(db: Database, accountId: string, principalId: string, source: SeatSource): Promise<D1PreparedStatement[]> {
  // The shared billing counter/segments/events contract is the same one used by
  // identity membership removal. The immutable operation ID fences reductions.
  await ensureBillingAccount({ DB: db as D1Database }, accountId);
  const id = `seat_remove_${await sha256([accountId, principalId, source.kind, source.id, String(source.generation)].join('\n'))}`;
  const at = now();
  return [
    ...condition(db, 'NOT EXISTS (SELECT 1 FROM billing_seat_events WHERE id=?)', id),
    ...guarded(db, stmt(db, 'UPDATE billing_accounts SET seat_count=seat_count-1,revision=revision+1,updated_at=? WHERE account_id=? AND seat_count>0', at, accountId)),
    stmt(db, 'UPDATE billing_plan_segments SET ended_at=? WHERE account_id=? AND ended_at IS NULL', at, accountId),
    stmt(db, `INSERT INTO billing_plan_segments(id,account_id,plan_id,seat_count,started_at,created_at)
      SELECT ?,account_id,plan_id,seat_count,?,? FROM billing_accounts WHERE account_id=?`, `segment:${id}`, at, at, accountId),
    stmt(db, 'INSERT INTO billing_seat_events(id,account_id,principal_id,delta,occurred_at) VALUES (?,?,?,-1,?)', id, accountId, principalId, at),
    eventStatement(db, { id: `evt:${id}`, type: 'billing.seat.removed', resource_id: id, resource_revision: 1, account_id: accountId,
      actor_id: source.actor_id, data: { principal_id: principalId, seats: -1 } }),
    auditStatement(db, { action: 'billing.seat.removed', resource_id: id, resource_revision: 1, account_id: accountId,
      actor_id: source.actor_id, details: { principal_id: principalId, operation_id: source.id } }),
  ];
}

async function reserveMembershipSeat(db: Database, env: Bindings, provider: Provider, principalId: string, source: SeatSource): Promise<Admission> {
  const preview = await previewSeatChange(env, { account_id: provider.account_id, additional_seats: 1 });
  const id = newId('fseat');
  const input = { account_id: provider.account_id, principal_id: principalId, additional_seats: 1,
    request_id: `federation:${id}`, expected_revision: preview.subscription_revision };
  const request = JSON.stringify(input);
  const admission: Admission = { id, account_id: provider.account_id, provider_id: provider.id, principal_id: principalId,
    source_kind: source.kind, source_id: source.id, source_generation: source.generation, source_attempt: source.attempt_id,
    request_json: request, request_hash: await sha256(request), expected_billing_revision: preview.subscription_revision,
    reservation_id: null, state: 'preparing', expires_at: source.expires_at, created_at: now() };
  await federationBatch(db, [...sourceGuard(db, source), ...providerGuard(db, provider), stmt(db, `INSERT INTO federation_seat_admissions
    (id,account_id,provider_id,principal_id,source_kind,source_id,source_generation,source_attempt,request_json,request_hash,expected_billing_revision,state,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'preparing',?,?)`, id, admission.account_id, provider.id, principalId, source.kind, source.id, source.generation,
  source.attempt_id, request, admission.request_hash, preview.subscription_revision, source.expires_at, admission.created_at)]);
  try {
    const reserved = await reserveSeatChange(env, input);
    admission.reservation_id = reserved.reservation_id;
    const persisted = await one<{ state: Admission['state'] }>(db, `UPDATE federation_seat_admissions SET reservation_id=?,
      state=CASE WHEN state='preparing' THEN 'reserved' ELSE state END WHERE id=? AND account_id=? RETURNING state`, reserved.reservation_id, id, provider.account_id);
    if (persisted?.state !== 'reserved') throw new ApiError(409, 'seat_request_superseded', 'The membership admission was fenced. Retry the provisioning request.');
    admission.state = 'reserved';
    return admission;
  } catch (error) {
    if (error instanceof BillingError && !admission.reservation_id) {
      // BillingError before a returned reservation is an explicit rejected
      // preview/admission or a rolled-back guarded billing transaction.
      await stmt(db, "UPDATE federation_seat_admissions SET state='cancelled' WHERE id=? AND state='preparing'", id).run();
    } else await cancelMembershipAdmission(db, id);
    throw error;
  }
}

/** Automatic provider provisioning is admitted against the same holds as invitations. */
export async function prepareMembershipFinance(db: Database, env: Bindings | undefined, provider: Provider, principalId: string,
  active: boolean, source: SeatSource): Promise<MembershipFinance> {
  const snapshot = await seatSnapshot(db, provider.account_id, principalId);
  const removeGrants = active ? [] : [stmt(db, `UPDATE access_grants SET revoked_at=?,revision=revision+1,updated_at=?
    WHERE account_id=? AND principal_id=? AND principal_type='user' AND effect='allow' AND revoked_at IS NULL`, now(), now(), provider.account_id, principalId)];
  if (snapshot.occupied === active) return { guards: snapshot.guards, statements: removeGrants, admission_id: null };
  if (!active) return { guards: snapshot.guards, statements: [...removeGrants, ...await reductionStatements(db, provider.account_id, principalId, source)], admission_id: null };
  if (!env) throw new ApiError(503, 'seat_admission_unavailable', 'Organization provisioning requires the billing admission bindings.');
  await ensureBillingAccount(env, provider.account_id);
  const admission = await reserveMembershipSeat(db, env, provider, principalId, source);
  try {
    const accept = await seatAcceptanceStatements(db, { account_id: provider.account_id, principal_id: principalId, reservation_id: admission.reservation_id! });
    return { guards: snapshot.guards, statements: [
      ...guarded(db, stmt(db, "UPDATE federation_seat_admissions SET state='consumed' WHERE id=? AND account_id=? AND state='reserved'", admission.id, provider.account_id)),
      ...accept,
    ], admission_id: admission.id };
  } catch (error) { await cancelMembershipAdmission(db, admission.id); throw error; }
}

/** Fencing the membership writer precedes releasing its unconsumed shared hold. */
export async function cancelMembershipAdmission(db: Database, id: string | null): Promise<void> {
  if (!id) return;
  await stmt(db, "UPDATE federation_seat_admissions SET state='cancelling' WHERE id=? AND state IN ('preparing','reserved')", id).run();
  const state = await one<Admission & { billing_revision: number | null; receipt_id: string | null; receipt_state: string | null }>(db,
    `SELECT f.*,b.revision AS billing_revision,r.id AS receipt_id,r.state AS receipt_state FROM federation_seat_admissions f
      LEFT JOIN billing_accounts b ON b.account_id=f.account_id
      LEFT JOIN billing_seat_reservations r ON r.account_id=f.account_id AND r.request_hash=f.request_hash
      WHERE f.id=? AND f.state='cancelling'`, id);
  if (!state) return;
  if (state.receipt_state === 'consumed') throw new ApiError(503, 'seat_reconciliation_required', 'A consumed billing seat has no matching membership receipt.');
  if (state.receipt_id) {
    if (state.receipt_state !== 'cancelled') {
      try { await cancelSeatReservation({ DB: db as D1Database }, { account_id: state.account_id, reservation_id: state.receipt_id }); }
      catch (error) {
        const actual = await one<{ state: string }>(db, 'SELECT state FROM billing_seat_reservations WHERE id=? AND account_id=?', state.receipt_id, state.account_id);
        if (actual?.state !== 'cancelled') throw error;
      }
    }
    await stmt(db, "UPDATE federation_seat_admissions SET state='cancelled',reservation_id=? WHERE id=? AND state='cancelling'", state.receipt_id, id).run();
  } else if (state.billing_revision !== null && state.billing_revision !== state.expected_billing_revision) {
    // This snapshot proves the old reservation CAS can no longer insert later.
    await stmt(db, "UPDATE federation_seat_admissions SET state='cancelled' WHERE id=? AND state='cancelling'", id).run();
  }
}

export async function recoverSeatAdmissions(db: Database, maximum = 50): Promise<void> {
  const rows = await db.prepare(`SELECT * FROM federation_seat_admissions WHERE state='cancelling'
    OR (state IN ('preparing','reserved') AND expires_at<=?) ORDER BY created_at,id LIMIT ?`).bind(now(), Math.min(50, maximum)).all<Admission>();
  for (const row of rows.results) {
    if (row.expires_at <= now() && row.source_kind === 'scim') {
      await stmt(db, `UPDATE federation_scim_requests SET generation=generation+1,attempt_id=?,status='uncertain',lease_expires_at=?,updated_at=?
        WHERE id=? AND generation=? AND attempt_id=? AND committed_at IS NULL AND lease_expires_at<=?`, newId('fattempt'), now(), now(),
      row.source_id, row.source_generation, row.source_attempt, now()).run();
    } else if (row.expires_at <= now() && row.source_kind === 'flow') {
      await stmt(db, 'DELETE FROM federation_auth_flows WHERE id=? AND account_id=? AND provider_id=? AND completed_at IS NULL AND expires_at<=?',
        row.source_id, row.account_id, row.provider_id, now()).run();
    }
    await cancelMembershipAdmission(db, row.id);
  }
}

export async function cancelOlderScimSeatAdmissions(db: Database, sourceId: string, generation: number): Promise<void> {
  const rows = await db.prepare(`SELECT id FROM federation_seat_admissions WHERE source_kind='scim' AND source_id=?
    AND source_generation<? AND state IN ('preparing','reserved','cancelling') ORDER BY created_at,id LIMIT 50`).bind(sourceId, generation).all<{ id: string }>();
  for (const row of rows.results) await cancelMembershipAdmission(db, row.id);
}
