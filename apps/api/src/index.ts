import { Hono } from 'hono';
import {
  ApiError, apiRoutes, browserBoundary, database, errorResponse, identityContext,
  handleRoutingRpc, limits, openApiDocument, protocolIdentityContext, requestContext, requirePrincipal, route, routeResourceRequest,
} from '@gitknot/core';
import type { App, AppEnv, Bindings } from '@gitknot/core';
import { registerIdentityRoutes } from './modules/identity.ts';
import { registerAccountRoutes } from './modules/accounts.ts';
import { registerRepositoryRoutes } from './modules/repositories.ts';
import { registerCollaborationRoutes } from './modules/collaboration.ts';
import { registerGitRoutes } from './modules/git.ts';
import { registerWorkflowsRoutes } from './modules/workflows.ts';
import { isRunnerProtocolRequest, registerRunnersRoutes } from './modules/runners.ts';
import { registerBillingRoutes } from './modules/billing.ts';
import { registerSecretsRoutes } from './modules/secrets.ts';
import { registerIntegrationsRoutes } from './modules/integrations.ts';
import { registerOperationsRoutes } from './modules/operations.ts';
import { isFederationProtocolCallback, registerFederationRoutes } from './modules/federation.ts';
import { registerAuditRoutes, registerStorageRoutes } from './modules/storage.ts';
import { registerInternalMailRoutes } from './modules/internal-mail.ts';

export function createApp(): App {
  const app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.use('*', requestContext);
  app.use('/internal/*', async (c, next) => {
    const response = await handleRoutingRpc(c.req.raw, c.env);
    if (response) return response;
    await next();
  });
  app.use('/openapi.json', browserBoundary);
  app.use('/v1/*', (c, next) => isFederationProtocolCallback(c.req.raw) ? next() : browserBoundary(c, next));
  app.use('/v1/*', async (c, next) => {
    const response = await routeResourceRequest(c);
    if (response) return response;
    await next();
  });
  app.use('/v1/*', (c, next) => {
    if (isFederationProtocolCallback(c.req.raw)) return next();
    return isRunnerProtocolRequest(c.req.raw) ? protocolIdentityContext(c, next) : identityContext(c, next);
  });
  app.use('/scim/*', identityContext);

  app.get('/health/live', c => c.json({ status: 'ok', service: 'gitknot-api', version: '1.0.0' }));
  app.get('/health/ready', async c => {
    await database(c).prepare('SELECT id,revision,policy_revision,routing_epoch FROM repositories LIMIT 1').first();
    limits(c.env);
    return c.json({ status: 'ready' });
  });

  registerIdentityRoutes(app);
  registerAccountRoutes(app);
  registerRepositoryRoutes(app);
  registerCollaborationRoutes(app);
  registerGitRoutes(app);
  registerWorkflowsRoutes(app);
  registerRunnersRoutes(app);
  registerBillingRoutes(app);
  registerSecretsRoutes(app);
  registerIntegrationsRoutes(app);
  registerOperationsRoutes(app);
  registerFederationRoutes(app);
  registerInternalMailRoutes(app);
  registerStorageRoutes(app);
  registerAuditRoutes(app);

  route(app, 'GET', '/v1/meta', { summary: 'Discover GitKnot API conventions and configured resource limits', tags: ['platform'], public: true }, c => {
    const config = limits(c.env);
    return c.json({
      api_version: '1', product: 'GitKnot', web_origin: c.env.APP_ORIGIN, api_origin: c.env.API_ORIGIN,
      git_origin: c.env.GIT_ORIGIN, transports: ['https'], openapi_url: `${c.env.API_ORIGIN}/openapi.json`,
      pagination: { default_limit: 30, maximum_limit: config.page_size, cursor: 'opaque' },
      concurrency: { precondition: 'If-Match', idempotency: 'Idempotency-Key', replay_days: 30 },
      limits: { json_bytes: config.json_bytes, upload_bytes: config.upload_bytes, git_push_bytes: config.git_push_bytes,
        repository_bytes: config.repository_bytes, blob_bytes: config.blob_bytes },
      visibility: ['public', 'private', 'internal', 'unlisted'],
    });
  });
  route(app, 'GET', '/v1/api-capabilities', { summary: 'Discover credential scope and API permission requirements', tags: ['platform'] }, c => {
    const principal = requirePrincipal(c);
    return c.json({
      principal: { id: principal.id, kind: principal.kind, mfa: principal.mfa },
      credential_ceiling: { capabilities: principal.capabilities, repository_ids: principal.repository_ids, account_ids: principal.account_ids },
      operations: apiRoutes(app).map(item => ({ method: item.method, path: item.path, summary: item.summary, capability: item.capability ?? null })),
      permission_explanation: '/v1/repos/{repo_id}/permissions/explain',
    });
  });

  app.get('/openapi.json', c => c.json(openApiDocument(app, c.env.API_ORIGIN)));
  app.get('/v1/openapi.json', c => c.json(openApiDocument(app, c.env.API_ORIGIN)));
  app.all('/v1/*', () => { throw new ApiError(404, 'endpoint_not_found', 'This GitKnot API endpoint does not exist.'); });
  app.all('/internal/*', () => { throw new ApiError(404, 'not_found', 'The requested resource was not found.'); });
  app.all('*', async c => {
    const assets = c.env.ASSETS as Fetcher | undefined;
    if (assets && ['GET', 'HEAD'].includes(c.req.method)) return assets.fetch(c.req.raw);
    throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  });
  return app;
}

const app = createApp();
export default { fetch: (request: Request, env: Bindings, context: ExecutionContext) => app.fetch(request, env, context) };
