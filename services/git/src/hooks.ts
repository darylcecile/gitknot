import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { NativeGit } from './process.ts';
import { readHookManifest, validateReceive } from './validation.ts';
import type { HookManifest } from './validation.ts';
import { PacketReader } from './packets.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { parseRefCommand, pktLine } from '../../../packages/git/src/protocol.ts';
import type { GitEvidence, PublicationResult, RefUpdate } from '../../../packages/git/src/types.ts';

async function hookCall<T>(manifest: HookManifest, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${manifest.hook_url}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `GitKnot-Hook ${manifest.hook_token}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, manifest.deadline - Date.now())), redirect: 'error',
  });
  const data = await response.json() as T & { error?: { message?: string; code?: string } };
  if (!response.ok) throw new GitError(data.error?.code ?? 'publication_rejected', data.error?.message ?? 'Git publication was rejected.', response.status);
  return data;
}

async function preReceive(manifest: HookManifest, directory: string): Promise<void> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireValue(size <= manifest.policy.limits.max_refs * 1200, 'ref_limit', 'Git ref command list exceeds its limit.');
    buffers.push(chunk);
  }
  const updates = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers)).split('\n').filter(Boolean).map(parseRefCommand);
  const environment: Record<string, string> = {};
  for (const name of ['GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH']) {
    if (process.env[name]) environment[name] = process.env[name]!;
  }
  const git = new NativeGit(directory, manifest.policy.limits, manifest.deadline, manifest.development, environment);
  await git.run(['fsck', '--strict', '--no-reflogs', '--no-dangling'], { max_output: manifest.policy.limits.max_metadata_bytes });
  const evidence = await validateReceive(git, manifest, updates);
  await hookCall(manifest, 'validated', { evidence });
}

async function procReceive(manifest: HookManifest, directory: string): Promise<void> {
  const reader = new PacketReader(process.stdin);
  const version = await reader.packet();
  requireValue(version?.split('\0')[0] === 'version=1' && await reader.packet() === null, 'protocol_error', 'Unsupported proc-receive negotiation.');
  // Push options are not advertised. Atomic publication is enforced independently of the client flag.
  process.stdout.write(pktLine('version=1\0\n'));
  process.stdout.write('0000');
  const updates: RefUpdate[] = [];
  for (;;) {
    const line = await reader.packet();
    if (line === null) break;
    updates.push(parseRefCommand(line));
    requireValue(updates.length <= manifest.policy.limits.max_refs, 'ref_limit', 'Too many proc-receive commands.');
  }
  let result: PublicationResult;
  try {
    const evidence = JSON.parse(await readFile(join(directory, 'gitknot-evidence.json'), 'utf8')) as GitEvidence;
    requireValue(JSON.stringify(updates) === JSON.stringify(evidence.updates.map(({ old_oid, new_oid, ref }) => ({ old_oid, new_oid, ref }))),
      'publication_changed', 'Git ref commands changed after quarantine validation.');
    result = await hookCall<PublicationResult>(manifest, 'publish', { updates, evidence_digest: evidence.digest });
  } catch (error) {
    const message = error instanceof GitError ? error.message : 'Publication is pending reconciliation.';
    for (const update of updates) process.stdout.write(pktLine(`ng ${update.ref} ${message.replace(/[\r\n\0]/gu, ' ').slice(0, 200)}\n`));
    process.stdout.write('0000');
    return;
  }
  for (const update of updates) {
    const report = result.outcome === 'committed' ? `ok ${update.ref}\n`
      : `ng ${update.ref} ${(result.reason ?? 'Publication rejected.').replace(/[\r\n\0]/gu, ' ').slice(0, 200)}\n`;
    process.stdout.write(pktLine(report));
  }
  process.stdout.write('0000');
}

async function prePush(directory: string): Promise<void> {
  const expected = JSON.parse(await readFile(join(directory, 'gitknot-approved-publication.json'), 'utf8')) as RefUpdate[];
  const commands = new Map<string, { old_oid: string; new_oid: string }>();
  const input: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    requireValue(size <= 256 * 1024, 'publication_manifest', 'The publisher ref manifest exceeds its limit.');
    input.push(chunk);
  }
  for (const line of Buffer.concat(input).toString('utf8').split('\n').filter(Boolean)) {
    const match = /^[^ ]+ ([a-f0-9]{40}) (refs\/[^ ]+) ([a-f0-9]{40})$/u.exec(line);
    requireValue(match && !commands.has(match[2]), 'publication_manifest', 'Invalid publisher ref negotiation.');
    commands.set(match[2], { new_oid: match[1], old_oid: match[3] });
  }
  requireValue(commands.size === expected.length && expected.every(update => {
    const actual = commands.get(update.ref);
    return actual?.old_oid === update.old_oid && actual.new_oid === update.new_oid;
  }), 'stale_ref', 'Canonical refs changed or a requested ref was omitted. The exact conditional publication was rejected.');
  await writeFile(join(directory, 'gitknot-publication-ready'), JSON.stringify(expected), { mode: 0o600 });
}

let manifestForFailure: HookManifest | undefined;
try {
  const directory = process.cwd();
  if (process.argv[2] === 'pre-push') await prePush(directory);
  else {
    const manifest = await readHookManifest(directory);
    manifestForFailure = manifest;
    if (process.argv[2] === 'pre-receive') await preReceive(manifest, directory);
    else if (process.argv[2] === 'proc-receive') await procReceive(manifest, directory);
    else throw new Error('Unknown trusted Git hook.');
  }
} catch (error) {
  if (process.argv[2] === 'pre-receive' && manifestForFailure && error instanceof GitError) {
    await hookCall(manifestForFailure, 'rejected', { code: error.code, message: error.message }).catch(() => {});
  }
  process.stderr.write(`GitKnot: ${error instanceof GitError ? error.message : 'Native Git validation failed.'}\n`);
  process.exitCode = 1;
}
