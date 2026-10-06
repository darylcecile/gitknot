import { stmt } from '@gitknot/core';
import type { Database } from '@gitknot/core';
import { ScimError } from './errors.ts';
import type { Provider, ScimGroupRow, ScimUserRow } from './types.ts';

export type DirectoryUser = ScimUserRow & { relations_json: string };
export type DirectoryGroup = ScimGroupRow & { relations_json: string };

/** Metadata and its visible relationships are read by one SQLite statement. */
export function directoryColumns(kind: 'User' | 'Group'): string {
  const relation = kind === 'User'
    ? `SELECT g.id,g.display_name AS display FROM federation_scim_group_members gm JOIN federation_scim_groups g
        ON g.account_id=gm.account_id AND g.provider_id=gm.provider_id AND g.id=gm.group_id
        WHERE gm.account_id=r.account_id AND gm.provider_id=r.provider_id AND gm.scim_user_id=r.id
          AND g.deleted_at IS NULL ORDER BY g.id LIMIT 1001`
    : `SELECT u.id,u.user_name AS display FROM federation_scim_group_members gm JOIN federation_scim_users u
        ON u.account_id=gm.account_id AND u.provider_id=gm.provider_id AND u.id=gm.scim_user_id
        WHERE gm.account_id=r.account_id AND gm.provider_id=r.provider_id AND gm.group_id=r.id
          AND u.deleted_at IS NULL ORDER BY u.id LIMIT 1001`;
  return `r.*,(SELECT json_group_array(json_object('id',related.id,'display',related.display)) FROM (${relation}) related) AS relations_json`;
}

export function directoryRelations(row: DirectoryUser | DirectoryGroup): { id: string; display: string }[] {
  const values: unknown = JSON.parse(row.relations_json);
  if (!Array.isArray(values) || values.length > 1000 || values.some(value => !value || typeof value.id !== 'string' || typeof value.display !== 'string')) {
    throw new ScimError(503, 'The directory relationship snapshot exceeds its supported resource bounds.');
  }
  return values;
}

const modifiedAt = `CASE WHEN updated_at>=? THEN strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds') ELSE ? END`;

/** Called before replacing Group membership, in the Group's revision-guarded transaction. */
export function touchGroupUsers(db: Database, provider: Provider, groupId: string, desired: string[], renamed: boolean, at: string): D1PreparedStatement {
  const ids = JSON.stringify(desired);
  return stmt(db, `UPDATE federation_scim_users SET revision=revision+1,updated_at=${modifiedAt}
    WHERE account_id=? AND provider_id=? AND deleted_at IS NULL AND id IN (
      SELECT scim_user_id FROM federation_scim_group_members WHERE account_id=? AND provider_id=? AND group_id=?
        AND (?=1 OR scim_user_id NOT IN (SELECT value FROM json_each(?)))
      UNION SELECT value FROM json_each(?) WHERE value NOT IN (SELECT scim_user_id FROM federation_scim_group_members
        WHERE account_id=? AND provider_id=? AND group_id=?))`, at, at, provider.account_id, provider.id,
  provider.account_id, provider.id, groupId, Number(renamed), ids, ids, provider.account_id, provider.id, groupId);
}

/** User name/deletion affects every Group whose members representation includes it. */
export function touchUserGroups(db: Database, provider: Provider, userId: string, at: string): D1PreparedStatement {
  return stmt(db, `UPDATE federation_scim_groups SET revision=revision+1,updated_at=${modifiedAt}
    WHERE account_id=? AND provider_id=? AND deleted_at IS NULL AND id IN
      (SELECT group_id FROM federation_scim_group_members WHERE account_id=? AND provider_id=? AND scim_user_id=?)`,
  at, at, provider.account_id, provider.id, provider.account_id, provider.id, userId);
}
