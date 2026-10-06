import { Hono } from 'hono';
import { authenticate, authorize, browserBoundary, errorResponse, requestContext, requirePrincipal } from '@gitknot/core';
import type { AppEnv } from '@gitknot/core';
import { isFederationProtocolCallback, registerFederationRoutes } from '../../../apps/api/src/modules/federation.ts';
import { assertFederationIdentityContract, enforceOrganizationSso, restrictFederatedPrincipal } from '../src/integration.ts';
import { registerInvitationRoutes } from '../../../apps/api/src/modules/accounts/invitations.ts';
import { bindScimUser, claimScimRequest, commitScimMutation, currentScimRequest } from '../src/scim-requests.ts';
import { authenticateScim, readScimBody, scimResponse } from '../src/scim.ts';
import { sweepFederationState } from '../src/store.ts';
import { prepareMembershipFinance } from '../src/seats.ts';
import { scimErrorResponse } from '../src/errors.ts';
import { ApiError, getRepository, stmt } from '@gitknot/core';

// Test composition exercises the required core hooks and real protocol routes in workerd.
const app = new Hono<AppEnv>();
app.onError(errorResponse);
app.use('*', requestContext);
app.use('*', async (c, next) => {
  if (isFederationProtocolCallback(c.req.raw)) return next();
  return browserBoundary(c, next);
});
app.use('*', async (c, next) => {
  if (!isFederationProtocolCallback(c.req.raw)) {
    const principal = await authenticate(c.req.raw, c.env);
    c.set('principal', principal ? await restrictFederatedPrincipal(c.env.DB, principal) : null);
  }
  await next();
});
registerFederationRoutes(app);
registerInvitationRoutes(app);
app.get('/test/principal', c => c.json(requirePrincipal(c)));
app.get('/test/organizations/:orgId/permission', async c => {
  const principal = requirePrincipal(c);
  const capability = c.req.query('capability') ?? 'contents.read';
  await enforceOrganizationSso(c.env.DB, principal, c.req.param('orgId'), capability);
  await authorize(c, capability, { account_id: c.req.param('orgId') });
  return c.json({ allowed: true });
});
app.get('/test/missing-contract', async c => {
  await assertFederationIdentityContract({ ...c.env, FEDERATION_IDENTITY_CONTRACT: undefined });
  return c.json({ unreachable: true });
});
app.get('/test/repositories/:repoId/permission', async c => {
  const repository = await getRepository(c, c.req.param('repoId'), 'contents.read');
  await enforceOrganizationSso(c.env.DB, requirePrincipal(c), repository.owner_id, 'contents.read');
  return c.json({ id: repository.id, allowed: true });
});

// Test-only fault injection holds a real authenticated generation across a retry.
// Production exports and commit fences remain the ones exercised below.
const crashed = new Map<string, { context: Parameters<typeof commitScimMutation>[1]; c: Parameters<typeof commitScimMutation>[0] }>();
app.post('/test/scim/:orgId/crash', async c => {
  const context = await authenticateScim(c, 'scim.users.write');
  const body = await readScimBody(c);
  const request = new Request(`${c.env.API_ORIGIN}/scim/v2/${c.req.param('orgId')}/Users`, { method: 'POST', headers: c.req.raw.headers });
  c.req.raw = request;
  await claimScimRequest(c, context, 'User', body);
  if (c.req.header('x-test-after-seat') === '1') {
    const record = currentScimRequest(c);
    const userId = await bindScimUser(c);
    await prepareMembershipFinance(c.env.DB, c.env, context.provider, userId, true, { kind: 'scim', id: record.id,
      generation: record.generation, attempt_id: record.attempt_id, expires_at: new Date(Date.now() + 300_000).toISOString(), actor_id: context.principal.id });
  }
  crashed.set(c.req.header('idempotency-key')!, { context, c });
  throw new ApiError(503, 'test_worker_crashed', 'Injected crash after durable request admission.');
});
app.post('/test/scim/:orgId/stale-writer', async c => {
  await authenticateScim(c, 'scim.users.write');
  const stored = crashed.get(c.req.header('idempotency-key')!);
  if (!stored || stored.context.provider.account_id !== c.req.param('orgId')) return c.body(null, 404);
  try {
    await commitScimMutation(stored.c, stored.context, { type: 'test.stale_writer', resource_id: currentScimRequest(stored.c).planned_resource_id, resource_revision: 1 }, [
      stmt(c.env.DB, 'UPDATE federation_providers SET name=? WHERE account_id=? AND id=?', 'stale writer accepted', c.req.param('orgId'), stored.context.provider.id),
    ]);
  } catch (error) { return scimErrorResponse(error, c.get('requestId')); }
  return scimResponse(c, { unexpected: true });
});
app.post('/test/sweep', async c => { await sweepFederationState(c.env.DB); return c.body(null, 204); });

export default app;
