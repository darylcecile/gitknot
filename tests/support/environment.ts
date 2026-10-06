import { randomBytes } from 'node:crypto';
import { base64url, bytes, hex } from '../../packages/core/src/crypto.ts';
import type { Bindings } from '../../packages/core/src/types.ts';
import { createTestDatabase, type SqliteD1 } from './database.ts';
import { TestBucket, TestQueue } from './storage.ts';

function unavailable(name: string): Fetcher {
  return { fetch: async () => Response.json({ error: { code: 'test_service_unconfigured', message: `${name} was not configured for this scenario.` } }, { status: 503 }) } as unknown as Fetcher;
}

function namespace(name: string): DurableObjectNamespace {
  return {
    idFromName: (value: string) => ({ toString: () => value }),
    get: () => unavailable(name), getByName: () => unavailable(name),
  } as unknown as DurableObjectNamespace;
}

export interface TestEnvironment {
  env: Bindings;
  db: SqliteD1;
  blobs: TestBucket;
  backups: TestBucket;
  events: TestQueue<{ event_id: string }>;
  context: ExecutionContext;
  flush(): Promise<void>;
  close(): void;
}

export async function createTestEnvironment(overrides: Partial<Bindings> = {}): Promise<TestEnvironment> {
  const db = await createTestDatabase();
  const blobs = new TestBucket();
  const backups = new TestBucket();
  const events = new TestQueue<{ event_id: string }>();
  const sessionKey = overrides.SESSION_KEY ?? hex(randomBytes(32));
  const pending: Promise<unknown>[] = [];
  const workflow = { create: async () => { throw new Error('A Workflow adapter must be explicitly configured by this test.'); } } as unknown as Workflow;
  const env: Bindings = {
    DB: db.binding(), DIRECTORY_DB: db.binding(), SEARCH_DB: db.binding(),
    BLOBS: blobs.binding(), BACKUPS: backups.binding(), EVENTS: events.binding(),
    DISPATCH: new TestQueue<{ attempt_id: string; run_id?: string }>().binding(),
    WEBHOOK_DELIVERIES: new TestQueue<{ delivery_id: string }>().binding(),
    MAIL_DELIVERIES: new TestQueue<{ delivery_id: string }>().binding(),
    REPO_COORDINATOR: namespace('repository coordinator'), ADMISSION: namespace('admission'), ATTEMPTS: namespace('attempt controller'),
    RUN_WORKFLOW: workflow, OPERATIONS: workflow,
    GIT_SERVICE: unavailable('trusted Git'), SECRETS: unavailable('private vault'), EXECUTOR: unavailable('execution'),
    ENVIRONMENT: 'test', APP_ORIGIN: 'http://localhost:5173', API_ORIGIN: 'http://localhost:8787', GIT_ORIGIN: 'http://localhost:8788',
    CELL_ID: 'local', SHARD_ID: 'core', INTERNAL_SERVICE_KEY: hex(randomBytes(32)), SESSION_KEY: sessionKey,
    IDENTITY_KEYS_JSON: JSON.stringify({ current: 'session-v1', keys: { 'session-v1': base64url(bytes(sessionKey)) } }),
    ...overrides,
  };
  const context = { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}, props: {} } as ExecutionContext;
  return {
    env, db, blobs, backups, events, context,
    async flush() { await Promise.all(pending.splice(0)); },
    close() { db.close(); },
  };
}
