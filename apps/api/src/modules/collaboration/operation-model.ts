import { database, newId, now, registerResourceLocator, requirePrincipal, sha256, stmt } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';

export interface CollaborationOperation {
  id: string; kind: string; resource_id: string; repo_id: string | null; account_id: string | null;
  actor_id: string; status: 'pending' | 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: string; progress: number; revision: number; input_json: string; result_json: string | null;
  error_json: string | null; created_at: string; updated_at: string; completed_at: string | null;
}

export async function prepareOperation(c: AppContext, value: {
  kind: string; resource_id: string; repo?: Repository; item_id?: string; expected_item_revision?: number;
  input: Record<string, unknown>;
}): Promise<{ operation: CollaborationOperation; statements: D1PreparedStatement[] }> {
  const id = newId('op');
  await registerResourceLocator(c.env, { resource_id: id, resource_type: 'operation', repo_id: value.repo?.id ?? null });
  const at = now();
  const principal = requirePrincipal(c);
  const input = JSON.stringify(value.input);
  const operation: CollaborationOperation = { id, kind: `collaboration.${value.kind}`, resource_id: value.resource_id,
    repo_id: value.repo?.id ?? null, account_id: value.repo?.owner_id ?? null, actor_id: principal.id,
    status: 'pending', phase: 'queued', progress: 0, revision: 1, input_json: input, result_json: null, error_json: null,
    created_at: at, updated_at: at, completed_at: null };
  return { operation, statements: [
    stmt(database(c), `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,phase,progress,revision,input_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending','queued',0,1,?,?,?)`, id, operation.kind, value.resource_id,
    operation.repo_id, operation.account_id, principal.id, input, at, at),
    stmt(database(c), `INSERT INTO collaboration_operation_contexts(operation_id,repo_id,item_id,principal_json,expected_item_revision,input_digest,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`, id, operation.repo_id, value.item_id ?? null, JSON.stringify(principal),
    value.expected_item_revision ?? null, await sha256(input), at, at),
  ] };
}

export function publicOperation(operation: CollaborationOperation): Record<string, unknown> & { revision: number } {
  return { id: operation.id, kind: operation.kind, resource_id: operation.resource_id, repo_id: operation.repo_id,
    status: operation.status, phase: operation.phase, progress: operation.progress, revision: operation.revision,
    url: `/v1/operations/${operation.id}`, created_at: operation.created_at, updated_at: operation.updated_at };
}
