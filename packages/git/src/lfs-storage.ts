import { cancelStandaloneStorageIntent, commitStorageObject, reserveStandaloneStorage } from '@gitknot/billing';
import { mutationGuard, newId, now, one, registerResourceLocator, stmt } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { requireValue } from './errors.ts';

export interface BilledLfsUpload {
  id: string; object_id: string; account_id: string; repo_id: string; actor_id: string;
  size: number; oid: string; storage_key: string; billing_reservation_id: string | null; billing_fence: string | null;
  upload_generation: number;
}

export async function admitLfsStorage(env: Bindings, upload: BilledLfsUpload): Promise<void> {
  const reservation = await reserveStandaloneStorage(env, { account_id: upload.account_id, repo_id: upload.repo_id,
    actor_id: upload.actor_id, object_id: upload.object_id, key: upload.storage_key, bucket: 'blobs',
    maximum_bytes: String(upload.size), retention_until: null });
  requireValue(reservation.admission_state === 'ready' && reservation.maximum_bytes === String(upload.size)
    && reservation.key === upload.storage_key && reservation.account_id === upload.account_id,
  'lfs_billing_pending', 'Account-wide LFS storage admission is not ready.', 503);
  const persisted = await one<{ state: string; billing_reservation_id: string; billing_fence: string }>(env.DB,
    'SELECT state,billing_reservation_id,billing_fence FROM object_manifests WHERE id=? AND repo_id=?', upload.object_id, upload.repo_id);
  if (persisted && ['pending', 'uploading', 'ready'].includes(persisted.state)
    && persisted.billing_reservation_id === reservation.reservation_id && persisted.billing_fence === reservation.fence) {
    upload.billing_reservation_id = reservation.reservation_id; upload.billing_fence = reservation.fence; return;
  }
  const guard = newId('guard');
  await env.DB.batch([
    stmt(env.DB, `UPDATE object_manifests SET state='pending',billing_reservation_id=?,billing_fence=?,revision=revision+1,updated_at=?
      WHERE id=? AND repo_id=? AND account_id=? AND state='reserving' AND upload_generation=0`, reservation.reservation_id, reservation.fence, now(), upload.object_id, upload.repo_id, upload.account_id),
    mutationGuard(env.DB, guard),
    stmt(env.DB, "UPDATE git_lfs_uploads SET state='reserved',billing_reservation_id=?,billing_fence=? WHERE repo_id=? AND id=? AND state='reserving'",
      reservation.reservation_id, reservation.fence, upload.repo_id, upload.id),
    mutationGuard(env.DB, `${guard}_upload`), stmt(env.DB, 'DELETE FROM mutation_guards WHERE id IN (?,?)', guard, `${guard}_upload`),
  ]);
  upload.billing_reservation_id = reservation.reservation_id;
  upload.billing_fence = reservation.fence;
}

export async function beginLfsStorageWrite(env: Bindings, upload: BilledLfsUpload): Promise<void> {
  requireValue(upload.billing_reservation_id && upload.billing_fence, 'lfs_billing_pending', 'Account-wide LFS storage admission is incomplete.', 503);
  const guard = newId('guard');
  await env.DB.batch([
    stmt(env.DB, `UPDATE object_manifests SET state='uploading',upload_generation=upload_generation+1,upload_failure=NULL,
      upload_bytes_received=0,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND state='pending'
      AND billing_reservation_id=? AND billing_fence=? AND reference_count=0`, now(), upload.object_id, upload.repo_id, upload.billing_reservation_id, upload.billing_fence),
    mutationGuard(env.DB, guard),
    stmt(env.DB, `UPDATE git_lfs_uploads SET state='uploading',upload_generation=(SELECT upload_generation FROM object_manifests WHERE id=?)
      WHERE repo_id=? AND id=? AND state='reserved' AND expires_at>?`, upload.object_id, upload.repo_id, upload.id, now()),
    mutationGuard(env.DB, `${guard}_upload`), stmt(env.DB, 'DELETE FROM mutation_guards WHERE id IN (?,?)', guard, `${guard}_upload`),
  ]);
  const generation = await one<{ upload_generation: number }>(env.DB, 'SELECT upload_generation FROM git_lfs_uploads WHERE repo_id=? AND id=?', upload.repo_id, upload.id);
  requireValue(generation && generation.upload_generation > 0, 'lfs_upload_generation', 'The upload generation could not be verified.', 503);
  upload.upload_generation = generation.upload_generation;
}

export async function failedLfsInput(env: Bindings, upload: BilledLfsUpload): Promise<void> {
  // Only call after the upload owner proves an invalid/incomplete input stream, not a timeout
  // with potentially accepted bytes. The next generation and deletion race on this same row.
  await env.DB.batch([
    stmt(env.DB, `UPDATE object_manifests SET state='pending',upload_failure='input_incomplete',revision=revision+1,updated_at=?
      WHERE id=? AND repo_id=? AND state='uploading' AND billing_reservation_id=? AND billing_fence=? AND upload_generation=?`, now(), upload.object_id, upload.repo_id, upload.billing_reservation_id, upload.billing_fence, upload.upload_generation),
    stmt(env.DB, "UPDATE git_lfs_uploads SET state='reserved' WHERE repo_id=? AND id=? AND state='uploading' AND upload_generation=?", upload.repo_id, upload.id, upload.upload_generation),
  ]);
}

export async function commitLfsStorage(env: Bindings, upload: BilledLfsUpload, stored: R2Object): Promise<void> {
  const manifest = await one<{ account_id: string; billing_reservation_id: string; billing_fence: string; state: string }>(env.DB,
    'SELECT account_id,billing_reservation_id,billing_fence,state FROM object_manifests WHERE id=? AND repo_id=?', upload.object_id, upload.repo_id);
  requireValue(manifest && ['pending', 'uploading', 'ready'].includes(manifest.state), 'lfs_storage_fenced', 'The LFS object is fenced against publication.', 409);
  const result = await commitStorageObject(env, { account_id: manifest.account_id, reservation_id: manifest.billing_reservation_id,
    fence: manifest.billing_fence, object_id: upload.object_id, bytes: String(stored.size), etag: stored.etag, checksum: upload.oid });
  requireValue(result.state === 'stored', 'lfs_billing_pending', 'LFS storage acceptance is still being reconciled.', 503);
}

export async function deleteUnusedLfsStorage(env: Bindings, upload: BilledLfsUpload, unadmittedOnly = false): Promise<boolean> {
  const manifest = await one<{ state: string; revision: number; upload_generation: number; upload_failure: string | null }>(env.DB,
    'SELECT state,revision,upload_generation,upload_failure FROM object_manifests WHERE id=? AND repo_id=?', upload.object_id, upload.repo_id);
  if (!manifest || unadmittedOnly && manifest.state !== 'reserving') return false;
  if (manifest.state !== 'deleting') {
    if (!['reserving', 'pending'].includes(manifest.state) || manifest.upload_generation !== 0 && manifest.upload_failure !== 'input_incomplete') return false;
    const guard = newId('guard');
    await env.DB.batch([
      stmt(env.DB, `UPDATE object_manifests SET state='deleting',retention_until=NULL,revision=revision+1,updated_at=?
        WHERE id=? AND repo_id=? AND state=? AND revision=? AND reference_count=0 AND (upload_generation=0 OR upload_failure='input_incomplete')`,
      now(), upload.object_id, upload.repo_id, manifest.state, manifest.revision),
      mutationGuard(env.DB, guard),
      stmt(env.DB, "UPDATE git_lfs_uploads SET state='deleting' WHERE repo_id=? AND id=? AND state IN ('reserving','reserved')", upload.repo_id, upload.id),
      mutationGuard(env.DB, `${guard}_upload`), stmt(env.DB, 'DELETE FROM mutation_guards WHERE id IN (?,?)', guard, `${guard}_upload`),
    ]);
  }
  await registerResourceLocator(env, { resource_id: upload.object_id, resource_type: 'object', repo_id: upload.repo_id, authority: 'repository' });
  const receipt = await cancelStandaloneStorageIntent(env, { account_id: upload.account_id, object_id: upload.object_id, repo_id: upload.repo_id });
  requireValue(receipt.state === 'cancelled' && receipt.id === upload.object_id && receipt.account_id === upload.account_id
    && receipt.repo_id === upload.repo_id && receipt.key === upload.storage_key && receipt.bucket === 'blobs'
    && !await env.BLOBS.head(upload.storage_key), 'lfs_deletion_pending', 'LFS intent cancellation and physical deletion have not been confirmed.', 503);
  return true;
}
