import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeGit } from './process.ts';
import { objectInfo, totalObjectBytes } from './objects.ts';
import type { ObjectInfo } from './objects.ts';
import type { GitStorageEvidence, RefUpdate } from '../../../packages/git/src/types.ts';
import { ZERO_OID } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

interface StorageBaseline { baseline_bytes: string; baseline_oids: string[]; hidden_objects: ObjectInfo[] }
const filename = 'gitknot-storage-baseline.json';
const receiptPrefix = 'refs/gitknot/transactions/';

async function refs(git: NativeGit): Promise<Map<string, string>> {
  const output = await git.text(['for-each-ref', '--format=%(refname)%09%(objectname)']);
  return new Map(output.split('\n').filter(Boolean).map(line => { const [ref, oid] = line.split('\t'); return [ref, oid]; }));
}

async function graph(git: NativeGit, roots: Iterable<string>): Promise<Map<string, ObjectInfo>> {
  const ids = [...new Set(roots)];
  if (!ids.length) return new Map();
  const output = await git.text(['rev-list', '--objects', '--no-object-names', '--stdin'], {
    input: `${ids.join('\n')}\n`, max_output: git.limits.max_objects * 41,
  });
  return objectInfo(git, output.split('\n').filter(Boolean));
}

/** Metadata only: untrusted receivers must not inherit inaccessible canonical object bodies. */
export async function copyStorageBaseline(source: NativeGit, target: NativeGit): Promise<void> {
  const current = await refs(source);
  const logical = await graph(source, [...current].filter(([ref]) => !ref.startsWith(receiptPrefix)).map(([, oid]) => oid));
  const hidden = await graph(source, [...current].filter(([ref]) => ref.startsWith('refs/gitknot/') && !ref.startsWith(receiptPrefix)).map(([, oid]) => oid));
  const baseline: StorageBaseline = { baseline_bytes: String(totalObjectBytes(logical, source.limits.max_repository_bytes)),
    baseline_oids: [...logical.keys()], hidden_objects: [...hidden.values()] };
  await writeFile(join(target.directory, filename), JSON.stringify(baseline), { mode: 0o600 });
}

export async function storageEvidence(git: NativeGit, updates: RefUpdate[]): Promise<GitStorageEvidence> {
  const current = await refs(git);
  const visible = [...current].filter(([ref]) => !ref.startsWith(receiptPrefix));
  let baseline: StorageBaseline;
  try { baseline = JSON.parse(await readFile(join(git.directory, filename), 'utf8')) as StorageBaseline; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const old = await graph(git, visible.map(([, oid]) => oid));
    baseline = { baseline_bytes: String(totalObjectBytes(old, git.limits.max_repository_bytes)), baseline_oids: [...old.keys()], hidden_objects: [] };
  }
  const proposed = new Map(visible);
  for (const update of updates) {
    if (update.new_oid === ZERO_OID) proposed.delete(update.ref); else proposed.set(update.ref, update.new_oid);
  }
  const after = await graph(git, proposed.values());
  for (const info of baseline.hidden_objects) after.set(info.oid, info);
  requireValue(after.size <= git.limits.max_objects, 'repository_object_limit', 'The repository exceeds its configured object-count limit.', 413);
  const before = new Set(baseline.baseline_oids);
  let added = 0n;
  const digest = createHash('sha256');
  for (const object of [...after.values()].sort((a, b) => a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0)) {
    digest.update(`${object.oid} ${object.type} ${object.size}\n`);
    if (!before.has(object.oid)) added += BigInt(object.size);
  }
  const reachable = totalObjectBytes(after, git.limits.max_repository_bytes);
  // A conservative reservation includes native object framing and the internal transaction
  // marker. It is an admission bound, not a claimed provider physical-storage measurement.
  const maximum = added + BigInt(after.size * 128 + git.limits.max_metadata_bytes + 1024);
  return { model: 'logical-reachable-v1', baseline_bytes: baseline.baseline_bytes, reachable_bytes: String(reachable),
    new_object_bytes: String(added), object_count: String(after.size), object_manifest_digest: digest.digest('hex'), maximum_growth_bytes: String(maximum) };
}

export async function markerObjectBytes(git: NativeGit, marker: string): Promise<string> {
  return String(totalObjectBytes(await graph(git, [marker]), git.limits.max_metadata_bytes + 1024));
}
