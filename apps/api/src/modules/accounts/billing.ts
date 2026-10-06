import { identityDatabase as database } from '@gitknot/core/authority';
import { ensureBillingAccount, previewSeatChange, reserveSeatChange, seatAcceptanceStatements, cancelSeatReservation, type SeatPreview } from '@gitknot/billing';
import { ApiError, eventStatement, newId, now, one, stmt, type AppContext } from '@gitknot/core';
import { checkedWrite } from '@gitknot/core/auth';
import { identityBindings } from '../identity/shared.ts';

export async function alreadyHasSeat(c: AppContext, accountId: string, userId: string): Promise<boolean> {
  return await seatBalance(c, accountId, userId) > 0;
}

const balanceSql = `(CASE WHEN COALESCE(a.initial_seat_principal_id,a.owner_user_id)=? THEN 1 ELSE 0 END
  +COALESCE((SELECT SUM(e.delta) FROM billing_seat_events e WHERE e.account_id=a.id AND e.principal_id=?
    AND (e.delta<0 OR EXISTS (SELECT 1 FROM billing_seat_reservations r WHERE r.id=e.reservation_id
      AND r.account_id=e.account_id AND r.principal_id=e.principal_id AND r.state='consumed'))),0))`;

async function seatBalance(c: AppContext, accountId: string, userId: string): Promise<number> {
  const row = await one<{ seats: number }>(database(c), `SELECT ${balanceSql} AS seats FROM accounts a WHERE a.id=?`, userId, userId, accountId);
  return row?.seats ?? 0;
}

/** Account-level grants require organization admission, not merely a repo grant. */
export async function requireAccountGrantAdmission(c: AppContext, accountId: string, userId: string): Promise<D1PreparedStatement[]> {
  const member = await one(database(c), "SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND state='active'", accountId, userId);
  if (!member) throw new ApiError(422, 'invitation_required', 'Account-wide access requires an accepted organization membership. Invite this person first.');
  if (!await alreadyHasSeat(c, accountId, userId)) throw new ApiError(409, 'seat_reservation_required', 'This person has no allocated account seat. Complete the invitation or provisioning admission first.');
  const guard = newId('guard');
  return [stmt(database(c), `INSERT INTO identity_write_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
    SELECT 1 FROM accounts a JOIN memberships m ON m.account_id=a.id WHERE a.id=? AND m.principal_id=?
      AND m.state='active' AND ${balanceSql}>0) THEN 1 ELSE 0 END`, guard, accountId, userId, userId, userId),
  stmt(database(c), 'DELETE FROM identity_write_guards WHERE id=?', guard)];
}

export async function invitationSeatPreview(c: AppContext, accountId: string, userId: string | null): Promise<SeatPreview> {
  return previewSeatChange(identityBindings(c), { account_id: accountId, additional_seats: userId && await alreadyHasSeat(c, accountId, userId) ? 0 : 1 });
}

export interface SeatAcknowledgment {
  subscription_revision: number;
  plan_id: string;
  maximum_monthly_units: string;
  maximum_current_period_units: string;
}

export async function reserveInvitationSeat(c: AppContext, accountId: string, userId: string, invitationId: string, acknowledgement: SeatAcknowledgment): Promise<{ reservation_id: string | null; statements: D1PreparedStatement[] }> {
  const preview = await invitationSeatPreview(c, accountId, userId);
  if (preview.subscription_revision !== acknowledgement.subscription_revision || preview.plan_id !== acknowledgement.plan_id
    || BigInt(preview.monthly_delta_units) > BigInt(acknowledgement.maximum_monthly_units)
    || BigInt(preview.maximum_current_period_units) > BigInt(acknowledgement.maximum_current_period_units)) {
    throw new ApiError(412, 'seat_quote_changed', 'Review the current seat quote before accepting this invitation.', { seat_quote: preview });
  }
  if (preview.additional_seats === 0) return { reservation_id: null, statements: [] };
  const reservation = await reserveSeatChange(identityBindings(c), { account_id: accountId, principal_id: userId, additional_seats: 1,
    request_id: `invitation:${invitationId}:${userId}:${acknowledgement.subscription_revision}`, expected_revision: acknowledgement.subscription_revision });
  return { reservation_id: reservation.reservation_id, statements: await seatAcceptanceStatements(database(c),
    { account_id: accountId, principal_id: userId, reservation_id: reservation.reservation_id }) };
}

export async function abandonInvitationSeat(c: AppContext, accountId: string, reservationId: string | null): Promise<void> {
  if (reservationId) await cancelSeatReservation(identityBindings(c), { account_id: accountId, reservation_id: reservationId });
}

/** Seat reduction shares the membership-removal transaction and its revision guard. */
export async function seatRemovalStatements(c: AppContext, accountId: string, principalId: string): Promise<D1PreparedStatement[]> {
  const principal = await one<{ kind: string }>(database(c), 'SELECT kind FROM principals WHERE id=?', principalId);
  if (principal?.kind !== 'user') return [];
  const seats = await seatBalance(c, accountId, principalId);
  if (seats <= 0) return [];
  await ensureBillingAccount(identityBindings(c), accountId);
  const id = newId('seat_event');
  const timestamp = now();
  return [
    ...checkedWrite(database(c), stmt(database(c), `UPDATE billing_accounts SET seat_count=seat_count-?,revision=revision+1,updated_at=?
      WHERE account_id=? AND seat_count>=? AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=? AND ${balanceSql}=?)`,
    seats, timestamp, accountId, seats, accountId, principalId, principalId, seats)),
    stmt(database(c), 'UPDATE billing_plan_segments SET ended_at=? WHERE account_id=? AND ended_at IS NULL', timestamp, accountId),
    stmt(database(c), `INSERT INTO billing_plan_segments(id,account_id,plan_id,seat_count,started_at,created_at)
      SELECT ?,account_id,plan_id,seat_count,?,? FROM billing_accounts WHERE account_id=?`, `segment:${id}`, timestamp, timestamp, accountId),
    stmt(database(c), 'INSERT INTO billing_seat_events(id,account_id,principal_id,delta,occurred_at) VALUES (?,?,?,?,?)', id, accountId, principalId, -seats, timestamp),
    eventStatement(database(c), { type: 'billing.seat.removed', resource_id: id, resource_revision: 1, account_id: accountId,
      actor_id: c.get('principal')?.id, data: { principal_id: principalId, seats: -seats } }),
  ];
}
