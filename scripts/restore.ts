import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { localKeys } from '../infra/cloudflare.ts';
import { ROOT, environment } from '../infra/environment.ts';
import { verifyPortableArchive } from '../infra/recovery/archive.ts';
import { OperationsClient, type OperationRequest } from '../infra/recovery/client.ts';
import { loadD1Snapshot, materializeD1Snapshot, restoreD1 } from '../infra/recovery/d1.ts';
import { backgroundHttp, readRoute, requestShardMove, verifyMovedRoute, type MoveRequest } from '../infra/recovery/move.ts';
import { main, writeJson } from '../infra/process.ts';

async function restore(): Promise<void> {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'development' }, 'base-url': { type: 'string', default: 'http://localhost:8787' },
    repo: { type: 'string' }, 'archive-id': { type: 'string' }, revision: { type: 'string' }, 'operation-id': { type: 'string' },
    'verify-file': { type: 'string' }, sha256: { type: 'string' }, execute: { type: 'boolean', default: false }, wait: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '1800' }, out: { type: 'string' },
    database: { type: 'string' }, snapshot: { type: 'string' }, 'download-to': { type: 'string' },
    'resume-bookmark': { type: 'string' },
    move: { type: 'boolean', default: false }, 'target-cell': { type: 'string' }, 'target-shard': { type: 'string' }, 'expected-epoch': { type: 'string' },
    'background-origin': { type: 'string' }, 'idempotency-key': { type: 'string' },
  }, strict: true });
  if (values['verify-file']) {
    const verified = await verifyPortableArchive(resolve(values['verify-file']), values.sha256 ? z.string().regex(/^[a-f0-9]{64}$/).parse(values.sha256) : undefined);
    console.log(JSON.stringify({ archive_id: verified.manifest.archive_id, repository_id: verified.manifest.repository.id, sha256: verified.sha256, bytes: verified.bytes, git_verified: verified.git_verified }, null, 2));
    return;
  }
  const env = environment(values.mode);
  if (values.database) {
    if (!values.snapshot) throw new Error('--database requires a retained --snapshot manifest.');
    let snapshot = await loadD1Snapshot(resolve(values.snapshot));
    if (!values.execute) {
      console.log(JSON.stringify({ action: 'restore-d1-into-fresh-database', mode: env.mode, cell_id: env.cell, database: values.database,
        source: snapshot.source, sha256: snapshot.sha256, revoke_restored_credentials: true, routing_switched: false }, null, 2));
      return;
    }
    if (values['download-to']) snapshot = await materializeD1Snapshot(env, snapshot, resolve(values['download-to']));
    const restored = await restoreD1(env, values.database, snapshot, values['resume-bookmark']);
    const output = values.out ? resolve(values.out) : join(ROOT, '.gitknot', 'recovery', `${snapshot.id}-${env.cell}.json`);
    await writeJson(output, restored);
    console.log(JSON.stringify(restored, null, 2));
    console.log(`Fresh-database restore receipt: ${output}`);
    return;
  }
  const repo = z.string().regex(/^r_[\w-]+$/).parse(values.repo);
  const timeout = z.coerce.number().int().positive().max(86400).parse(values.timeout);
  if (values.move) {
    const input: MoveRequest = { repo_id: repo,
      target_cell_id: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/).parse(values['target-cell']),
      target_shard_id: z.string().regex(/^core-\d{3}$/).parse(values['target-shard']),
      expected_epoch: z.coerce.number().int().positive().parse(values['expected-epoch']),
    };
    if (!values.execute) { console.log(JSON.stringify({ action: 'durable-shard-move', ...input, steps: ['copy', 'verify', 'fence', 'final-copy', 'restore-Git-into-fresh-cell', 'verify', 'epoch-CAS', 'retain-source'] }, null, 2)); return; }
    const origin = values['background-origin'] ?? (env.mode === 'development' ? 'http://localhost:8787' : undefined);
    if (!origin) throw new Error('Set --background-origin to your authenticated operator gateway for the private BACKGROUND service.');
    const key = env.mode === 'development' ? localKeys().background.INTERNAL_SERVICE_KEY! : process.env.GITKNOT_INTERNAL_SERVICE_KEY;
    if (!key) throw new Error('GITKNOT_INTERNAL_SERVICE_KEY is required for private maintenance operations.');
    const output = values.out ? resolve(values.out) : join(ROOT, '.gitknot', 'recovery', `${repo}-move-${randomUUID()}.json`);
    if (!values['operation-id']) {
      const source = await readRoute(env, repo);
      if (source.epoch !== input.expected_epoch || source.state !== 'active' || source.operation_id) throw new Error('Source route changed or is already fenced. Refresh before starting the move.');
    }
    await writeJson(output, { version: 1, input, status: 'submitting', operation_id: values['operation-id'] });
    const operation = values['operation-id'] ? { id: values['operation-id'], status: 'pending' } : await requestShardMove(backgroundHttp(origin, key), key, input);
    await writeJson(output, { version: 1, input, status: 'submitted', operation_id: operation.id });
    console.log(`Move operation ${operation.id}. Receipt: ${output}`);
    if (values.wait) {
      const client = new OperationsClient(values['base-url']!, process.env.GITKNOT_OPERATOR_TOKEN ?? '');
      await client.wait(operation.id, timeout);
      const destination = await readRoute(env, repo);
      verifyMovedRoute(destination, input);
      await writeJson(output, { version: 1, input, status: 'completed', operation_id: operation.id, destination, routing_verified: true });
      console.log(`Verified routing epoch ${destination.epoch} at ${destination.cell_id}/${destination.shard_id}.`);
    }
    return;
  }
  const revision = z.coerce.number().int().positive().parse(values.revision);
  const archive = z.string().regex(/^archive_[\w-]+$/).parse(values['archive-id']);
  const request: OperationRequest = { path: `/v1/repos/${repo}/restore`, revision, body: { archive_id: archive },
    idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(values['idempotency-key'] ?? randomUUID()),
  };
  if (!values.execute) { console.log(JSON.stringify({ method: 'POST', origin: values['base-url'], ...request, expected_effect: 'Fenced restore to new Git storage, checksum/ref verification and credential revocation.' }, null, 2)); return; }
  const client = new OperationsClient(values['base-url']!, process.env.GITKNOT_OPERATOR_TOKEN ?? '');
  const output = values.out ? resolve(values.out) : join(ROOT, '.gitknot', 'recovery', `${repo}-${request.idempotency_key}.json`);
  await writeJson(output, { version: 1, request, status: 'submitting' });
  const operation = values['operation-id'] ? { id: values['operation-id'] } : await client.create(request);
  await writeJson(output, { version: 1, request, operation_id: operation.id, status: 'submitted' });
  console.log(`Restore operation ${operation.id}. Receipt: ${output}`);
  if (values.wait) {
    const completed = await client.wait(operation.id, timeout);
    if (completed.result?.restored !== true) throw new Error('Completed operation did not return a verified restore result.');
    await writeJson(output, { version: 1, request, operation_id: operation.id, status: 'completed', result: completed.result });
    console.log(`Repository ${repo} restored through its durable publication gate.`);
  }
}

main(restore);
