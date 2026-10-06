import { ApiError, identityBinding, identityDatabaseLocation, internalFetch, one, readBounded, verifyInternalRequest } from '@gitknot/core';
import { z } from 'zod';
import { BillingError, invariant } from './errors.ts';
import type { BillingBindings } from './types.ts';

type AdmissionBindings = Pick<BillingBindings, 'ADMISSION' | 'INTERNAL_SERVICE_KEY'> & Partial<BillingBindings>;

async function admissionCell(env: AdmissionBindings, target: string): Promise<string | null> {
  if (!env.DB || !env.CELL_ID || !env.SHARD_ID) return null;
  const full = env as BillingBindings, db = identityBinding(full).withSession('first-primary');
  if (target.startsWith('capacity:')) {
    const slice = await one<{ cell_id: string }>(db, 'SELECT cell_id FROM billing_capacity_slices WHERE id=?', target.slice('capacity:'.length));
    return slice?.cell_id ?? env.CELL_ID;
  }
  const control = await one<{ cell_id: string | null }>(db, "SELECT json_extract(body_json,'$.coordinator_cell_id') AS cell_id FROM billing_controls WHERE coordinator_id=?", target);
  return control?.cell_id ?? identityDatabaseLocation(full).cell_id;
}

export async function admissionRequest<T>(env: AdmissionBindings, target: string, action: string, payload: unknown = {}): Promise<T> {
  invariant(/^(account|capacity):[A-Za-z0-9_-]{1,128}$/.test(target) && /^[a-z-]+$/.test(action), 'admission_scope', 'Invalid admission resource.', 422);
  invariant(typeof env.INTERNAL_SERVICE_KEY === 'string' && env.INTERNAL_SERVICE_KEY.length >= 32
    && !/placeholder|change[-_ ]?me|example|development[-_ ]?key/i.test(env.INTERNAL_SERVICE_KEY),
  'service_unconfigured', 'An operator-provisioned internal signing key is required.', 503);
  const [kind, id] = target.split(':');
  const home = await admissionCell(env, target);
  let service: Pick<Fetcher, 'fetch'>;
  if (home && home !== env.CELL_ID) {
    const { billingCellService } = await import('./storage-policy.ts');
    service = billingCellService(env as BillingBindings, home);
  } else service = env.ADMISSION.get(env.ADMISSION.idFromName(target));
  let response: Response;
  try {
    response = home && home !== env.CELL_ID
      ? await internalFetch(service as Fetcher, env.INTERNAL_SERVICE_KEY, 'billing.route', '/internal/billing/admission', { target, action, payload })
      : await internalFetch(service as Fetcher, env.INTERNAL_SERVICE_KEY, `billing:${kind}:${action}`, `/internal/billing/${kind}/${id}/${action}`, payload);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new BillingError('admission_unavailable', 'Admission state could not be verified; no new allocation is authorized.', 503);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null;
    const status = [400, 403, 404, 409, 412, 422, 429].includes(response.status) ? response.status as BillingError['status'] : 503;
    throw new BillingError(body?.error?.code ?? 'admission_unavailable', status === 503 ? 'Admission is unavailable; existing holds remain in force.'
      : body?.error?.message ?? 'Admission was rejected.', status, body?.error?.details);
  }
  return response.json() as Promise<T>;
}

/** Fixed one-hop forwarding to the recorded coordinator home, independent of repository cutover. */
export async function handleBillingAdmissionRequest(request: Request, env: BillingBindings): Promise<Response> {
  await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'billing.route');
  const input = z.object({ target: z.string().regex(/^(account|capacity):[A-Za-z0-9_-]{1,128}$/), action: z.string().regex(/^[a-z-]+$/), payload: z.unknown() }).strict()
    .parse(JSON.parse(new TextDecoder().decode(await readBounded(request.body, 128 * 1024))));
  invariant(await admissionCell(env, input.target) === env.CELL_ID, 'admission_home_changed', 'This request reached another financial authority.', 503);
  return Response.json(await admissionRequest(env, input.target, input.action, input.payload));
}
