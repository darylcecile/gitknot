import { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { INTERNAL_REFS } from '../../../packages/git/src/types.ts';
import { validateOid, validatePath, validateRef } from '../../../packages/git/src/policy.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { NativeGit } from './process.ts';
import type { GitStream } from './process.ts';
import { objectInfo } from './objects.ts';

export interface GitRef { ref: string; oid: string; type: string }

export async function visibleRefs(git: NativeGit, candidateRef?: string | string[]): Promise<GitRef[]> {
  const output = await git.text(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(objecttype)', 'refs/'], { max_output: git.limits.max_metadata_bytes });
  return output.split('\n').filter(Boolean).map(line => {
    const [ref, oid, type] = line.split('\t');
    return { ref, oid, type };
  }).filter(value => Array.isArray(candidateRef) ? candidateRef.includes(value.ref) : candidateRef ? value.ref === candidateRef : !value.ref.startsWith(INTERNAL_REFS));
}

/** Object hashes are usable only after proving association with the authorized ref audience. */
export async function associatedObject(git: NativeGit, oid: string, candidateRef?: string | string[]): Promise<void> {
  validateOid(oid, false);
  const refs = await visibleRefs(git, candidateRef);
  requireValue(refs.length > 0, 'object_not_found', 'Git object not found.', 404);
  if (refs.some(ref => ref.oid === oid)) return;
  const objects = await git.text(['rev-list', '--objects', '--no-object-names', '--stdin'], {
    input: `${refs.map(ref => ref.oid).join('\n')}\n`, max_output: git.limits.max_objects * 41,
  });
  requireValue(objects.split('\n').includes(oid), 'object_not_found', 'Git object not found.', 404);
}

export async function resolveCommit(git: NativeGit, value: string, candidateRef?: string): Promise<string> {
  let revision = value;
  if (/^[a-f0-9]{40}$/u.test(value)) await associatedObject(git, value, candidateRef);
  else {
    const refs = await visibleRefs(git, candidateRef);
    if (value === 'HEAD') {
      const head = await git.text(['symbolic-ref', '--quiet', 'HEAD']);
      revision = candidateRef ?? head;
    } else if (!value.startsWith('refs/')) {
      const matches = refs.filter(ref => ref.ref === `refs/heads/${value}` || ref.ref === `refs/tags/${value}`);
      requireValue(matches.length === 1, 'ref_not_found', 'Git ref is missing or ambiguous.', 404);
      revision = matches[0].ref;
    }
    validateRef(revision, !!candidateRef);
    requireValue(refs.some(ref => ref.ref === revision), 'ref_not_found', 'Git ref not found.', 404);
  }
  const result = await git.run(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], { allow_failure: true });
  requireValue(result.code === 0, 'commit_not_found', 'Git commit not found.', 404);
  return result.stdout.toString().trim();
}

export async function readCommit(git: NativeGit, oid: string): Promise<Record<string, unknown>> {
  const raw = await git.run(['cat-file', 'commit', oid]);
  const text = raw.stdout.toString();
  const split = text.indexOf('\n\n');
  const headers = text.slice(0, split).split('\n');
  const identity = (name: string): Record<string, string | number> => {
    const header = headers.find(line => line.startsWith(`${name} `))?.slice(name.length + 1) ?? '';
    const match = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/u.exec(header);
    return match ? { name: match[1], email: match[2], timestamp: Number(match[3]), timezone: match[4] } : { raw: header };
  };
  return { oid, tree: headers.find(line => line.startsWith('tree '))?.slice(5),
    parents: headers.filter(line => line.startsWith('parent ')).map(line => line.slice(7)),
    author: identity('author'), committer: identity('committer'), message: text.slice(split + 2),
    has_signature: headers.some(line => line.startsWith('gpgsig ')),
  };
}

interface TreeEntry { mode: string; type: string; oid: string; name: string; size: number | null }

export async function readTree(git: NativeGit, oid: string): Promise<TreeEntry[]> {
  const output = await git.run(['ls-tree', '-z', '-l', oid]);
  return new TextDecoder('utf-8', { fatal: true }).decode(output.stdout).split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, type, hash, size] = entry.slice(0, tab).trim().split(/\s+/u);
    return { mode, type, oid: hash, size: size === '-' ? null : Number(size), name: entry.slice(tab + 1) };
  });
}

async function pathObject(git: NativeGit, commit: string, path: string): Promise<TreeEntry> {
  validatePath(path);
  let tree = await git.text(['rev-parse', '--verify', `${commit}^{tree}`]);
  const segments = path.split('/');
  let result: TreeEntry | undefined;
  for (let index = 0; index < segments.length; index++) {
    result = (await readTree(git, tree)).find(entry => entry.name === segments[index]);
    requireValue(result && (index === segments.length - 1 || result.type === 'tree'), 'file_not_found', 'Repository path not found.', 404);
    tree = result.oid;
  }
  return result!;
}

export async function browse(git: NativeGit, path: string, params: URLSearchParams, candidateRef?: string): Promise<Response> {
  const limit = integer(params.get('limit'), 50, 1, 200);
  const ref = params.get('ref') ?? 'HEAD';
  if (path === 'refs') {
    const refs = await visibleRefs(git, candidateRef);
    const cursor = params.get('cursor') ?? '';
    const items = refs.filter(item => item.ref > cursor).slice(0, limit + 1);
    return Response.json({ items: items.slice(0, limit), next_cursor: items.length > limit ? items[limit - 1].ref : null });
  }
  if (path === 'tree' && params.has('oid')) {
    const oid = params.get('oid')!;
    await associatedObject(git, oid, candidateRef);
    const info = (await objectInfo(git, [oid])).get(oid)!;
    requireValue(info.type === 'tree', 'tree_not_found', 'Git tree not found.', 404);
    return treeResponse(await readTree(git, oid), oid, params, limit);
  }
  const commit = await resolveCommit(git, ref, candidateRef);
  if (path === 'commit') return Response.json(await readCommit(git, commit), { headers: { etag: `"${commit}"` } });
  if (path === 'commits') {
    const offset = integer(params.get('cursor'), 0, 0, git.limits.max_commits);
    const oids = await git.text(['rev-list', '--topo-order', `--max-count=${limit + 1}`, `--skip=${offset}`, commit]);
    const ids = oids.split('\n').filter(Boolean);
    const items = [];
    for (const id of ids.slice(0, limit)) items.push(await readCommit(git, id));
    return Response.json({ items, revision: commit, next_cursor: ids.length > limit ? String(offset + limit) : null });
  }
  if (path === 'tree' || path === 'raw') {
    const relative = params.get('path');
    const object = relative ? await pathObject(git, commit, relative)
      : { oid: await git.text(['rev-parse', `${commit}^{tree}`]), type: 'tree' };
    if (path === 'tree') {
      requireValue(object.type === 'tree', 'tree_not_found', 'Git tree not found.', 404);
      return treeResponse(await readTree(git, object.oid), object.oid, params, limit);
    }
    requireValue(object.type === 'blob', 'file_not_found', 'Repository file not found.', 404);
    return streamResponse(git.stream(['cat-file', 'blob', object.oid]), {
      'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff', etag: `"${object.oid}"`,
      'content-disposition': 'attachment', 'content-security-policy': "default-src 'none'; sandbox",
    });
  }
  if (path === 'diff' || path === 'compare') {
    const base = await resolveCommit(git, params.get('base') ?? '', candidateRef);
    const mergeBases = await git.text(['merge-base', '--all', base, commit], { allow_failure: true });
    if (path === 'compare') {
      const counts = (await git.text(['rev-list', '--left-right', '--count', `${base}...${commit}`])).split(/\s+/u).map(Number);
      const paths = await git.text(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', base, commit]);
      return Response.json({ base_oid: base, head_oid: commit, merge_bases: mergeBases ? mergeBases.split('\n') : [],
        behind: counts[0], ahead: counts[1], files: parseNumstat(paths), truncated: false });
    }
    return streamResponse(git.stream(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', base, commit, '--'], {
      max_output: git.limits.max_output_bytes,
    }), { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
  }
  if (path === 'archive') {
    const format = params.get('format') ?? 'tar.gz';
    requireValue(['tar', 'tar.gz', 'zip'].includes(format), 'archive_format', 'Unsupported archive format.');
    const child = git.stream(['archive', `--format=${format === 'tar.gz' ? 'tar' : format}`, commit]);
    if (format === 'tar.gz') child.output = child.output.pipe(createGzip());
    return streamResponse(child, { 'content-type': format === 'zip' ? 'application/zip' : format === 'tar.gz' ? 'application/gzip' : 'application/x-tar',
      'content-disposition': `attachment; filename="${commit}.${format}"` });
  }
  throw new GitError('not_found', 'Git browsing operation not found.', 404);
}

export async function exportBundle(git: NativeGit, retainedRefs?: string[]): Promise<Response> {
  const refs = await visibleRefs(git);
  for (const ref of retainedRefs ?? []) {
    const oid = await git.text(['rev-parse', '--verify', '--end-of-options', ref]);
    refs.push({ ref, oid, type: 'commit' });
  }
  if (!refs.length && retainedRefs) return new Response(null, { headers: { 'content-type': 'application/x-git-bundle', 'x-gitknot-empty-repository': '1' } });
  requireValue(refs.length > 0, 'empty_repository', 'This repository has no Git refs; export its empty ref manifest instead.', 409);
  const path = join(git.directory, 'gitknot-export.bundle');
  await git.run(['bundle', 'create', path, ...refs.map(ref => ref.ref)]);
  await git.run(['bundle', 'verify', path]);
  const size = (await stat(path)).size;
  requireValue(size <= git.limits.max_output_bytes, 'export_limit', 'Repository export exceeds its byte limit.', 413);
  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, {
    headers: { 'content-type': 'application/x-git-bundle', 'content-length': String(size), 'content-disposition': 'attachment; filename="repository.bundle"' },
  });
}

export function streamResponse(task: GitStream, headers: Record<string, string>): Response {
  const stream = Readable.toWeb(task.output) as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (!next.done) { controller.enqueue(next.value); return; }
        const result = await task.completion;
        requireValue(result.code === 0, 'git_transfer_failed', 'Native Git could not complete this transfer.', 503);
        controller.close();
      } catch (error) { task.stop(); controller.error(error); }
    },
    async cancel(reason) { task.stop(); await reader.cancel(reason); await task.completion.catch(() => {}); },
  });
  return new Response(body, { headers: { ...headers, 'cache-control': 'private, no-store' } });
}

function treeResponse(entries: TreeEntry[], oid: string, params: URLSearchParams, limit: number): Response {
  const cursor = params.get('cursor') ?? '';
  const page = entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).filter(entry => entry.name > cursor).slice(0, limit + 1);
  return Response.json({ oid, items: page.slice(0, limit), next_cursor: page.length > limit ? page[limit - 1].name : null });
}

function parseNumstat(value: string): Array<{ additions: number | null; deletions: number | null; path: string }> {
  return value.split('\0').filter(Boolean).map(line => {
    const [added, removed, ...path] = line.split('\t');
    return { additions: added === '-' ? null : Number(added), deletions: removed === '-' ? null : Number(removed), path: path.join('\t') };
  });
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const result = Number(value);
  requireValue(Number.isSafeInteger(result) && result >= min && result <= max, 'invalid_pagination', 'Invalid Git pagination parameters.', 400);
  return result;
}
