import { setTimeout as delay } from 'node:timers/promises';
import { initializeVaultKeyring } from '../../packages/secrets/src/client.ts';
import { signInternalRequest } from '../../packages/core/src/internal.ts';

/** Loopback composition drives the real authenticated broker bootstrap before the local UI opens. */
export async function initializeLocalVault(serviceKeys: string, stopped: () => boolean): Promise<void> {
  const configured = JSON.parse(serviceKeys) as Record<string, { key: string; scopes: string[] }>;
  const operator = Object.entries(configured).find(([id, client]) => id.endsWith('-operator') && client.scopes.includes('vault.rotate'));
  if (!operator) throw new Error('Run node scripts/setup.ts --skip-install --skip-migrations to provision the local vault maintenance identity.');
  const service = { fetch: async (input: RequestInfo | URL) => {
    const request = input as Request, headers = new Headers(request.headers);
    headers.set('x-gitknot-local-service', 'secrets');
    const wire = new Request(`http://127.0.0.1:8787${new URL(request.url).pathname}`, new Request(request, { headers }));
    return fetch(await signInternalRequest(wire, operator[1].key, 'vault.rotate'), { redirect: 'manual' });
  } } as unknown as Fetcher;
  const deadline = Date.now() + 120000;
  while (!stopped()) {
    try { await initializeVaultKeyring({ SECRETS: service, SECRETS_CLIENT_ID: operator[0], SECRETS_CLIENT_KEY: operator[1].key }); return; }
    catch (error) {
      if (Date.now() >= deadline || error instanceof Error && 'status' in error && Number(error.status) < 500) throw error;
      await delay(250);
    }
  }
  throw new Error('Local vault initialization was interrupted.');
}
