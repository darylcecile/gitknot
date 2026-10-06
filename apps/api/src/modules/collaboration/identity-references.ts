import { ApiError, captureAccountAuthority, database, identityDatabase, now, one, selectedRepositoryScope, separateIdentityAuthority, sha256, stmt } from '@gitknot/core';
import type { AppContext } from '@gitknot/core';

export interface ReferencedUser { id: string; username: string; display_name: string; avatar_url: string | null }

async function currentUser(c: AppContext, id: string): Promise<ReferencedUser> {
  const user = await one<ReferencedUser>(identityDatabase(c), 'SELECT id,username,display_name,avatar_url FROM users WHERE id=? AND disabled_at IS NULL', id);
  if (!user) throw new ApiError(404, 'not_found', 'This user is not currently available.');
  return user;
}

/** A moved shard's disabled FK material never decides whether a user is active. */
export async function referencedUser(c: AppContext, id: string): Promise<ReferencedUser> {
  let user = await currentUser(c, id);
  if (!separateIdentityAuthority(c) || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return user;
  const owner = c.get('mutation_authority')?.policies.find(policy => policy.repo_id === selectedRepositoryScope(c))?.account_id ?? null;
  const account = await one<{ id: string; policy_revision: number }>(identityDatabase(c), `SELECT a.id,a.policy_revision FROM accounts a
    WHERE a.disabled_at IS NULL AND ((a.type='user' AND a.owner_user_id=?) OR EXISTS (
      SELECT 1 FROM memberships m WHERE m.account_id=a.id AND m.principal_id=? AND m.state='active'))
    ORDER BY (a.id=?) DESC,(a.type='user') DESC,a.id LIMIT 1`, id, id, owner);
  if (!account) throw new ApiError(404, 'user_reference_unavailable', 'The user has no current identity authority for this reference.');
  // Capture before the final primary read. Core carries this dependency epoch
  // into the source shard's atomic mutation guard and never refreshes it.
  await captureAccountAuthority(c, account.id, account.policy_revision);
  user = await currentUser(c, id);
  const key = (await sha256(id)).slice(0, 40), at = now();
  await stmt(database(c), `INSERT INTO users(id,username,email,display_name,disabled_at,created_at,updated_at)
    VALUES(?,?,?,'Metadata reference',?,?,?) ON CONFLICT(id) DO NOTHING`, id, `fk-${key}`, `fk-${key}@metadata.invalid`, at, at, at).run();
  return user;
}

export async function requireCurrentUserReference(c: AppContext, id: string): Promise<void> {
  if (!await one(identityDatabase(c), 'SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL', id)) {
    throw new ApiError(412, 'revision_conflict', 'A referenced user changed while this request was in flight.');
  }
}
