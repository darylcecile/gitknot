import { cellDatabase, identityBinding, many, one, resolveRepositoryPlacement, signInternalRequest } from '@gitknot/core';
import { routingBindings } from '@gitknot/core/routing/cells';
import { boundedJson } from '../../../packages/git/src/protocol.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { GIT_SERVICE_SCOPE } from '../../../packages/git/src/types.ts';
import { gitCell } from './placement.ts';
import type { GitBindings } from './types.ts';

export interface GitName { owner: string; name: string }
interface NameMatch { repo_id: string; current: boolean }

export function gitName(owner: string, name: string): GitName {
  requireValue([owner, name].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(value)), 'not_found', 'Git remote not found.', 404);
  return { owner, name };
}

/** Namespace rows are evidence only on the repository's currently selected placement. */
export async function localGitNames(env: GitBindings, input: GitName): Promise<NameMatch[]> {
  const { owner, name } = gitName(input.owner, input.name);
  const account = await one<{ id: string }>(identityBinding(env).withSession('first-primary'),
    'SELECT id FROM accounts WHERE slug=? COLLATE NOCASE AND disabled_at IS NULL', owner);
  const shards = [...new Set([env.SHARD_ID, ...Object.keys(routingBindings(env.SHARD_BINDINGS_JSON))])];
  const matches: NameMatch[] = [];
  for (const shard of shards) {
    const rows = await many<{ repo_id: string; current: number; routing_epoch: number }>(cellDatabase(env, shard).withSession('first-primary'),
      `SELECT id AS repo_id,1 AS current,routing_epoch FROM repositories WHERE owner_id=? AND slug=? COLLATE NOCASE AND cell_id=? AND shard_id=?
       UNION ALL SELECT r.id AS repo_id,0 AS current,r.routing_epoch FROM repository_aliases a JOIN repositories r ON r.id=a.repo_id
       WHERE a.owner_slug=? COLLATE NOCASE AND a.repository_slug=? COLLATE NOCASE AND r.cell_id=? AND r.shard_id=? LIMIT 3`,
    account?.id ?? null, name, env.CELL_ID, shard, owner, name, env.CELL_ID, shard);
    for (const row of rows) {
      const placement = await resolveRepositoryPlacement(env, row.repo_id);
      if (placement?.cell_id === env.CELL_ID && placement.shard_id === shard && placement.epoch === row.routing_epoch) {
        matches.push({ repo_id: row.repo_id, current: row.current === 1 });
      }
    }
  }
  return matches;
}

/** Fixed private lookups use bounded cell/shard maps, never copied account or ACL data. */
export async function resolveGitName(env: GitBindings, input: GitName): Promise<string> {
  const gitBindings = routingBindings(env.CELL_GIT_BINDINGS_JSON, 32);
  const configured = Object.keys(routingBindings(env.CELL_BINDINGS_JSON, 32)).filter(cell => cell !== env.CELL_ID);
  requireValue(configured.every(cell => gitBindings[cell]), 'git_cell_unavailable', 'The Git peer bindings are incomplete.', 503);
  const cells = Object.keys(gitBindings).filter(cell => cell !== env.CELL_ID);
  const matches = await localGitNames(env, input);
  for (let offset = 0; offset < cells.length; offset += 8) {
    const pages = await Promise.all(cells.slice(offset, offset + 8).map(async cell => {
      const request = new Request('https://internal.gitknot.com/internal/git/namespace', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(20_000),
      });
      const response = await gitCell(env, cell).fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_SERVICE_SCOPE));
      const result = await boundedJson<{ matches: NameMatch[] }>(response, 32 * 1024);
      requireValue(response.ok && Array.isArray(result.matches) && result.matches.length <= 130
        && result.matches.every(match => typeof match.repo_id === 'string' && /^[\w-]{1,128}$/u.test(match.repo_id) && typeof match.current === 'boolean'),
      'git_namespace_unavailable', 'The current Git repository namespace could not be confirmed.', 503);
      return result.matches;
    }));
    matches.push(...pages.flat());
  }
  const current = matches.filter(match => match.current);
  const ids = [...new Set((current.length ? current : matches).map(match => match.repo_id))];
  requireValue(ids.length <= 1, 'git_namespace_conflict', 'The Git repository namespace is being reconciled.', 503);
  requireValue(ids.length === 1, 'not_found', 'Git remote not found.', 404);
  return ids[0];
}
