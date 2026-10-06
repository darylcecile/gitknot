import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index.ts';
import { createTestEnvironment, type TestEnvironment } from '../support/environment.ts';

describe('public HTTP contract', () => {
  const app = createApp();
  let fixture: TestEnvironment;

  beforeAll(async () => { fixture = await createTestEnvironment(); });
  afterAll(() => fixture.close());

  const request = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost:8787${path}`, init), fixture.env, fixture.context);

  it('publishes a usable versioned contract and request correlation without provider identifiers', async () => {
    const response = await request('/v1/meta');
    expect(response.status).toBe(200);
    const metadata = await response.json() as Record<string, unknown>;
    expect(metadata.api_version).toBe('1');
    expect(metadata.transports).toEqual(['https']);
    expect(response.headers.get('x-gitknot-request-id')).toMatch(/^req_/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(metadata)).not.toMatch(/storage_name|namespace_id|database_id|bucket_name/);

    const specification = await request('/openapi.json');
    expect(specification.status).toBe(200);
    const document = await specification.json() as { openapi: string; paths: Record<string, Record<string, { operationId: string; responses: object }>> };
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/v1/repos']).toBeDefined();
    expect(document.paths['/v1/meta']?.get).toBeDefined();
    const ids = Object.values(document.paths).flatMap(methods => Object.values(methods).map(operation => operation.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(document.paths).every(path => !path.includes(':'))).toBe(true);
  });

  it('rejects cross-site browser mutations before handling authentication data', async () => {
    const response = await request('/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' },
      body: JSON.stringify({ email: 'someone@example.invalid', password: 'not-a-real-password' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'origin_not_allowed', request_id: expect.any(String) } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('returns protocol errors rather than a successful SPA page for unknown API and private service routes', async () => {
    const [api, service] = await Promise.all([request('/v1/does-not-exist'), request('/internal/secrets/decrypt')]);
    for (const response of [api, service]) {
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: { request_id: expect.any(String) } });
    }
  });

  it('does not accept a forged actor header as an authenticated session', async () => {
    const response = await request('/v1/api-capabilities', { headers: { 'x-actor-id': 'u_owner', 'x-gitknot-actor': 'u_owner' } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'authentication_required' } });
  });
});
