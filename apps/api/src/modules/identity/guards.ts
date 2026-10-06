import { identityDatabase } from '@gitknot/core/authority';
import { many, newId, stmt, type AppContext, type EventInput } from '@gitknot/core';

/** Determine every primary account whose credential or recovery state can change. */
export async function affectedIdentityAccounts(c: AppContext, event: EventInput, additional: string[] = []): Promise<string[]> {
  const db = identityDatabase(c);
  const accounts = new Set(additional);
  const subjects = new Set<string>();
  if (event.account_id) accounts.add(event.account_id);
  if (event.type.startsWith('membership.')) subjects.add(event.resource_id);
  if (typeof event.data?.principal_id === 'string') subjects.add(event.data.principal_id);
  if (event.type === 'team.created' && c.get('principal')) subjects.add(c.get('principal')!.id);
  if (event.type === 'team.deleted') {
    for (const member of await many<{ principal_id: string }>(db, 'SELECT principal_id FROM team_members WHERE team_id=? AND account_id=?', event.resource_id, event.account_id)) subjects.add(member.principal_id);
  }
  if (/^identity\.(?:password_|email_changed|email_verified|mfa_|account_disabled)/.test(event.type)) subjects.add(event.resource_id);
  if (/^identity\.(?:passkey_|session_)/.test(event.type) && event.account_id) subjects.add(event.account_id);
  if (event.type.startsWith('identity.automation_') || /application\.(?:installation_updated|uninstalled)/.test(event.type)) subjects.add(event.resource_id);
  if (/^identity\.credential_(?:revoked|rotated|updated)$/.test(event.type)) {
    const id = typeof event.data?.previous_id === 'string' ? event.data.previous_id : event.resource_id;
    for (const row of await many<{ principal_id: string; user_id: string | null }>(db, 'SELECT principal_id,user_id FROM credentials WHERE id=?', id)) {
      subjects.add(row.principal_id);
      if (row.user_id) subjects.add(row.user_id);
    }
  }
  if (/^application\.(?:disabled|updated)$/.test(event.type)) {
    for (const row of await many<{ id: string; account_id: string }>(db, 'SELECT id,account_id FROM installations WHERE application_id=?', event.resource_id)) {
      subjects.add(row.id); accounts.add(row.account_id);
    }
  }
  if (subjects.size) {
    const encoded = JSON.stringify([...subjects]);
    const rows = await many<{ id: string }>(db, `WITH subjects AS (SELECT value AS id FROM json_each(?))
      SELECT a.id FROM accounts a WHERE (
        EXISTS (SELECT 1 FROM principals p WHERE p.id IN (SELECT id FROM subjects) AND (p.account_id=a.id OR p.user_id=a.id))
        OR EXISTS (SELECT 1 FROM federation_session_grants g WHERE g.user_id IN (SELECT id FROM subjects) AND g.account_id=a.id AND g.revoked_at IS NULL)
        OR EXISTS (SELECT 1 FROM credentials c LEFT JOIN principals p ON p.id=c.principal_id WHERE c.revoked_at IS NULL
          AND (c.user_id=a.id OR p.account_id=a.id)
          AND (c.principal_id IN (SELECT id FROM subjects) OR c.user_id IN (SELECT id FROM subjects) OR c.created_by IN (SELECT id FROM subjects)))
      )`, encoded);
    for (const row of rows) accounts.add(row.id);
    if (event.type === 'identity.account_disabled') {
      const memberships = await many<{ account_id: string }>(db, `SELECT account_id FROM memberships WHERE principal_id=?
        UNION SELECT account_id FROM access_grants WHERE principal_id=? AND revoked_at IS NULL`, event.resource_id, event.resource_id);
      for (const membership of memberships) accounts.add(membership.account_id);
    }
  }
  const existing = await many<{ id: string }>(db, 'SELECT id FROM accounts WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id', JSON.stringify([...accounts]));
  return existing.map(row => row.id);
}

/** Runs after the effects, in their transaction, and evaluates actual post-state. */
export function effectiveOwnerChecks(c: AppContext, accountIds: string[]): D1PreparedStatement[] {
  const db = identityDatabase(c);
  return [...new Set(accountIds)].flatMap(accountId => {
    const id = newId('owner_check');
    return [stmt(db, `INSERT INTO identity_owner_checks(id,account_id,ok) SELECT ?,?,CASE WHEN
      NOT EXISTS (SELECT 1 FROM accounts WHERE id=? AND type='organization' AND disabled_at IS NULL)
      OR EXISTS (SELECT 1 FROM identity_effective_owners WHERE account_id=?) THEN 1 ELSE 0 END`, id, accountId, accountId, accountId),
    stmt(db, 'DELETE FROM identity_owner_checks WHERE id=?', id)];
  });
}

export function changesIdentityAuthority(type: string): boolean {
  return /^(?:membership\.|team\.|role\.|organization\.disabled|account\.(?:policy_updated|grant_)|identity\.(?:automation_|credential_|session_(?:revoked|rotated|reauthenticated)|password_|email_changed|email_verified|mfa_|passkey_(?:registered|removed)|account_disabled)|application\.(?:installed|installation_updated|uninstalled|disabled|updated)|invitation\.accepted)/.test(type);
}
