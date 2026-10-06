import { signInternalRequest } from '../../packages/core/src/internal.ts';
import { z } from 'zod';
import { directoryName, localDatabaseId, LOCAL_STATE, type Environment } from '../environment.ts';
import { localCfJson } from '../local-cf.ts';
import { readD1Rows } from './d1.ts';
import type { MoveRequest } from './service.ts';
export { requestShardMove, type MoveRequest } from './service.ts';

export interface RouteReceipt { epoch: number; cell_id: string; shard_id: string; state: string; operation_id: string | null }

/** A reachable operator gateway must forward to the private background Worker. */
export function backgroundHttp(origin: string, key: string): Pick<Fetcher, 'fetch'> {
  const base = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((!local && base.protocol !== 'https:') || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Use a credential-free HTTPS maintenance origin or a loopback local router.');
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const original = input instanceof Request ? input : new Request(input, init);
      const source = new URL(original.url);
      const headers = new Headers(original.headers);
      if (local) headers.set('x-gitknot-local-service', 'background');
      // A transport-origin change must be re-signed because the core signature
      // covers Host as well as path/body/scope. Never forward an invalid signature.
      const request = new Request(new URL(source.pathname + source.search, base), new Request(original, { headers }));
      const signed = await signInternalRequest(request, key, 'operations.maintenance');
      return fetch(signed, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    },
  };
}

export async function readRoute(env: Environment, repoId: string): Promise<RouteReceipt> {
  if (!/^r_[\w-]+$/.test(repoId)) throw new Error('Invalid repository ID.');
  const sql = `SELECT epoch,cell_id,shard_id,state,operation_id FROM resource_routes WHERE resource_id='${repoId}'`;
  let rows: unknown[][];
  if (env.mode === 'development') {
    const response = await localCfJson(['d1', 'raw', localDatabaseId(directoryName(env)), '--local', '--persist-to', LOCAL_STATE, '--sql', sql]);
    const batches = z.array(z.object({ results: z.object({ rows: z.array(z.array(z.unknown())) }) })).parse(response);
    rows = batches.flatMap(batch => batch.results.rows);
  } else rows = await readD1Rows(env, 'd1.directory', sql);
  if (rows.length !== 1) throw new Error('Repository routing entry is missing or ambiguous.');
  const [epoch, cell_id, shard_id, state, operation_id] = rows[0]!;
  return z.object({ epoch: z.number().int().positive(), cell_id: z.string(), shard_id: z.string(), state: z.string(), operation_id: z.string().nullable() }).parse({ epoch, cell_id, shard_id, state, operation_id });
}

export function verifyMovedRoute(route: RouteReceipt, input: MoveRequest): void {
  if (route.epoch !== input.expected_epoch + 1 || route.cell_id !== input.target_cell_id || route.shard_id !== input.target_shard_id || route.state !== 'active' || route.operation_id !== null) {
    throw new Error('Destination routing epoch/activation did not match the completed move. Preserve both copies and reconcile the operation.');
  }
}
