import { now, one, stmt } from '@gitknot/core';
import type { AppContext, Principal } from '@gitknot/core';
import { reserveLfsUpload, completeLfsUpload, receiveLfsBytes } from '../../../packages/git/src/lfs.ts';
import type { LfsUpload } from '../../../packages/git/src/lfs.ts';
import { boundedJson } from '../../../packages/git/src/protocol.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { currentActor } from './policy.ts';
import { lifecycleRepository } from './lifecycle.ts';
import { readGitLimits } from '../../../packages/git/src/policy.ts';
import type { GitBindings } from './types.ts';

export async function lfsImportRoute(c: AppContext, env: GitBindings): Promise<Response> {
  const match = /^\/internal\/git\/lfs-import\/([\w-]+)\/([\w-]+)\/([\w-]+)\/(batch|uploads\/([\w-]+))$/u.exec(c.req.path);
  requireValue(match, 'not_found', 'Private LFS import endpoint not found.', 404);
  const [, repoId, operationId, publisherId, action, uploadId] = match;
  const streaming = action.startsWith('uploads/');
  const operation = await one<{ actor_json: string }>(env.DB, "SELECT actor_json FROM git_publications WHERE repo_id=? AND id=? AND publisher_id=? AND kind='import' AND state IN ('receiving','validated')", repoId, operationId, publisherId);
  requireValue(operation, 'lfs_import_state', 'The private import is no longer receiving objects.', 409);
  const actor = await currentActor(env, JSON.parse(operation.actor_json) as Principal);
  c.set('principal', actor);
  await lifecycleRepository(c, repoId, operationId, 'import');
  if (!streaming) {
    requireValue(c.req.method === 'POST', 'invalid_method', 'LFS batch admission requires POST.', 405);
    const body = await boundedJson<{ objects: Array<{ oid: string; size: number }> }>(c.req.raw, 128 * 1024);
    requireValue(Array.isArray(body.objects) && body.objects.length > 0 && body.objects.length <= readGitLimits(env.LIMITS_JSON).lfs_batch_objects, 'lfs_batch_limit', 'Invalid LFS import object batch.');
    const objects = [];
    for (const object of body.objects) {
      requireValue(/^[a-f0-9]{64}$/u.test(object.oid) && Number.isSafeInteger(object.size) && object.size >= 0, 'invalid_lfs_object', 'Invalid LFS import object.');
      const existing = await one<{ size: number }>(env.DB, "SELECT size FROM git_lfs_objects WHERE repo_id=? AND oid=? AND state='available'", repoId, object.oid);
      if (existing) { requireValue(existing.size === object.size, 'lfs_size', 'LFS object sizes disagree.'); objects.push(object); continue; }
      const upload = await reserveLfsUpload(env, repoId, actor, object, null);
      objects.push({ ...object, upload_id: upload.id, upload_url: `${env.GIT_ORIGIN}/internal/git/lfs-import/${repoId}/${operationId}/${publisherId}/uploads/${upload.id}` });
    }
    return Response.json({ objects });
  }
  requireValue(c.req.method === 'PUT' && c.req.raw.body, 'invalid_method', 'LFS import upload requires object bytes.', 400);
  const upload = await one<LfsUpload>(env.DB, "SELECT * FROM git_lfs_uploads WHERE repo_id=? AND id=? AND actor_id=? AND state IN ('reserved','uploading','complete') AND expires_at>?", repoId, uploadId, actor.id, now());
  requireValue(upload && c.req.header('x-gitknot-content-sha256') === upload.oid, 'lfs_upload_scope', 'LFS import upload does not match its reservation.', 403);
  await receiveLfsBytes(env, upload, c.req.raw.body);
  await completeLfsUpload(env, upload);
  return Response.json({ verified: true });
}
