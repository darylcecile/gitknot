import { ApiError, identityBinding, many, mutationStatements, newId, now, one, selectIdentityDatabase, stmt, withAccountAuthorityBarrier } from '@gitknot/core';
import type { AppContext, Bindings, EventInput, Principal } from '@gitknot/core';
import { executionContext } from './authorization.ts';

export function identityExecutionContext(env: Bindings, principal: Principal | null, captured?: AppContext): AppContext {
  const context = executionContext(env, principal);
  selectIdentityDatabase(context);
  const authority = captured?.get('mutation_authority');
  if (authority) context.set('mutation_authority', authority);
  return context;
}

export async function commitIdentityCredential(env: Bindings, authority: AppContext, statements: D1PreparedStatement[], event: EventInput): Promise<void> {
  const context = identityExecutionContext(env, authority.get('principal'), authority);
  await identityBinding(env).batch(await mutationStatements(context, { statements, event }));
}

/** Revocation is cleanup. It remains available inside an already-fenced account. */
export async function revokeExecutionCredentials(env: Bindings, ids: string[], reason: string): Promise<void> {
  if (!ids.length) return;
  const db = identityBinding(env).withSession('first-primary');
  const rows = await many<{ id: string; account_id: string | null; user_id: string | null }>(db, `SELECT c.id,p.account_id,c.user_id FROM credentials c JOIN principals p ON p.id=c.principal_id
    WHERE c.id IN (SELECT value FROM json_each(?)) AND c.revoked_at IS NULL`, JSON.stringify(ids));
  if (!rows.length) return;
  const accounts = new Set(rows.flatMap(row => row.account_id ? [row.account_id] : []));
  for (const row of rows) if (row.user_id) {
    const personal = await one<{ id: string }>(db, `SELECT id FROM accounts WHERE type='user' AND owner_user_id=?`, row.user_id);
    if (personal) accounts.add(personal.id);
  }
  const context = identityExecutionContext(env, null), ordered = [...accounts].sort();
  const held: Array<{ account_id: string; barrier_id: string }> = [];
  const apply = async (index: number): Promise<void> => {
    const accountId = ordered[index];
    if (accountId) {
      const existing = await one<{ id: string; phase: string }>(db, `SELECT b.id,e.phase FROM account_policy_barriers b JOIN account_authority_epochs e ON e.account_id=b.account_id AND e.barrier_id=b.id WHERE b.account_id=?`, accountId);
      if (existing) {
        if (existing.phase !== 'fenced') throw new ApiError(409, 'revocation_fence_pending', 'The account revocation fence is still being installed.');
        held.push({ account_id: accountId, barrier_id: existing.id });
        return apply(index + 1);
      }
      return withAccountAuthorityBarrier(context, accountId, reason, () => apply(index + 1));
    }
    const guards = held.map(() => newId('guard'));
    await db.batch([
      ...held.map((hold, index) => stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
        SELECT 1 FROM account_policy_barriers b JOIN account_authority_epochs e ON e.account_id=b.account_id AND e.barrier_id=b.id
        WHERE b.account_id=? AND b.id=? AND e.phase='fenced') THEN 1 ELSE 0 END`, guards[index], hold.account_id, hold.barrier_id)),
      stmt(db, `UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL`, now(), JSON.stringify(rows.map(row => row.id))),
      stmt(db, 'DELETE FROM mutation_guards WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(guards)),
    ]);
  };
  await apply(0);
}
