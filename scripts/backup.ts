import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ROOT, environment } from '../infra/environment.ts';
import { resources } from '../infra/inventory.ts';
import { exportD1, storeD1Snapshot } from '../infra/recovery/d1.ts';
import { OperationsClient, type OperationRequest } from '../infra/recovery/client.ts';
import { verifyPortableArchive } from '../infra/recovery/archive.ts';
import { main, writeJson } from '../infra/process.ts';

async function backup(): Promise<void> {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, 'base-url': { type: 'string', default: 'http://localhost:8787' }, execute: { type: 'boolean', default: false },
    wait: { type: 'boolean', default: false }, timeout: { type: 'string', default: '1800' }, out: { type: 'string' },
    download: { type: 'string' }, 'idempotency-key': { type: 'string' }, 'operation-id': { type: 'string' },
    database: { type: 'string' }, mode: { type: 'string', default: 'production' }, upload: { type: 'boolean', default: false },
  }, strict: true });
  if (values.database) {
    const env = environment(values.mode);
    const selected = resources(env).filter(resource => resource.kind === 'd1' && resource.key !== 'd1.search' && !resource.existing && (values.database === 'all' || values.database === resource.key));
    if (!selected.length) throw new Error('Select all, d1.directory, or a resolved d1.core-00N database.');
    if (!values.execute) { console.log(JSON.stringify({ operation: 'D1 native SQL export', mode: env.mode, databases: selected.map(resource => resource.key), upload: values.upload, source: 'Provider polling export with real bookmarks; FTS excluded.' }, null, 2)); return; }
    const directory = values.out ? resolve(values.out) : join(ROOT, '.gitknot', 'backups', `d1-${new Date().toISOString().replaceAll(':', '-')}`);
    for (const resource of selected) {
      const exported = await exportD1(env, resource.key, directory);
      const snapshot = values.upload ? await storeD1Snapshot(env, exported) : exported;
      const manifest = join(directory, `${resource.key}-${snapshot.id}.json`);
      await writeJson(manifest, snapshot);
      console.log(`Verified SQL snapshot ${resource.key}: ${manifest}${snapshot.r2 ? `; R2 ${snapshot.r2.manifest_key}` : ''}`);
    }
    return;
  }
  const repo = z.string().regex(/^r_[\w-]+$/).parse(values.repo);
  const request: OperationRequest = { path: `/v1/repos/${repo}/backups`, body: {}, idempotency_key: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(values['idempotency-key'] ?? randomUUID()) };
  if (!values.execute) {
    console.log(JSON.stringify({ method: 'POST', origin: values['base-url'], ...request, expected_effect: 'Durable backup operation, verified Git bundle plus collaboration/LFS/object manifests and bytes.' }, null, 2));
    return;
  }
  const client = new OperationsClient(values['base-url']!, process.env.GITKNOT_OPERATOR_TOKEN ?? '');
  const output = values.out ? resolve(values.out) : join(ROOT, '.gitknot', 'backups', `${repo}-${request.idempotency_key}.json`);
  // Record the idempotency key before issuing work so a lost response can be
  // retried without creating a second independent operation.
  await writeJson(output, { version: 1, repository_id: repo, origin: client.origin, request, status: 'submitting' });
  const initial = values['operation-id'] ? { id: values['operation-id'] } : await client.create(request);
  await writeJson(output, { version: 1, repository_id: repo, origin: client.origin, request, operation_id: initial.id, status: 'submitted' });
  console.log(`Backup operation: ${initial.id}. Receipt: ${output}`);
  if (!values.wait && !values.download) return;
  const operation = await client.wait(initial.id, z.coerce.number().int().positive().max(86400).parse(values.timeout));
  const archiveId = operation.result?.archive_id;
  if (typeof archiveId !== 'string') throw new Error('Completed backup returned no archive ID.');
  let archive: unknown;
  if (values.download) {
    const file = resolve(values.download);
    const downloaded = await client.downloadArchive(archiveId, file);
    const verified = await verifyPortableArchive(file, downloaded.sha256);
    if (verified.manifest.repository.id !== repo || verified.manifest.archive_id !== archiveId) throw new Error('Downloaded backup identity does not match the operation.');
    archive = { path: file, sha256: verified.sha256, bytes: verified.bytes, git_verified: verified.git_verified };
  }
  await writeJson(output, { version: 1, repository_id: repo, origin: client.origin, request, operation_id: operation.id, status: operation.status, archive_id: archiveId, source_manifest_sha256: operation.result?.sha256, archive });
  console.log(`Backup ${archiveId} completed${values.download ? ' and its portable archive/Git graph verified' : ''}.`);
}

main(backup);
