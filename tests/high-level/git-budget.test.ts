import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AdmissionController, admissionRequest } from '../../packages/billing/src/index.ts';
import { HelperBudget } from '../../workers/git/src/helper-budget.ts';
import type { GitBindings } from '../../workers/git/src/types.ts';
import { createTestDatabase } from '../support/database.ts';
import type { SqliteD1 } from '../support/database.ts';

let db: SqliteD1;
let env: GitBindings;
let drop: string | undefined;
const identity = 'a'.repeat(64);
const originTime = Date.parse('2026-10-05T10:00:00.000Z');
type Snapshot = { control: { active_slots: number }; budgets: { reserved_units: string; settled_units: string }[] };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(originTime);
  db = await createTestDatabase();
  drop = undefined;
  env = { DB: db.binding(), DIRECTORY_DB: db.binding(), CELL_ID: 'local', SHARD_ID: 'core', ENVIRONMENT: 'test',
    BILLING_ESSENTIAL_SLICE_ID: 'slice_git_essential', GIT_HELPER_EGRESS_BYTES: '1024',
    INTERNAL_SERVICE_KEY: 'e063f96baf4ab65a8c0a9b8ee9b0445c157a3f3934aa49c88f3da469c86c8d56' } as unknown as GitBindings;
  const at = new Date().toISOString();
  const until = new Date(Date.now() + 86400_000).toISOString();
  db.sqlite.prepare(`INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,
    allocated_units,max_instances,allocated_instances,state,purpose) VALUES ('pool_git_essential',?,?,'1000000000000','0','0','1000000000',1,1,'active','essential')`).run(at, until);
  db.sqlite.prepare(`INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at,purpose)
    VALUES ('slice_git_essential','pool_git_essential','local','1000000000',1,'1000000',?,'active',?,'essential')`).run(until, at);
  const controllers = new Map<string, AdmissionController>();
  env.ADMISSION = { idFromName: (name: string) => ({ toString: () => name }), get(id: { toString(): string }) {
    const name = id.toString();
    let controller = controllers.get(name);
    if (!controller) {
      controller = new AdmissionController({ id, storage: new MemoryStorage(), blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback(), waitUntil() {} } as unknown as DurableObjectState,
        { ...env, GIT_HELPER_OPERATIONS: '1' });
      controllers.set(name, controller);
    }
    return { fetch: async (request: Request) => {
      const response = await controller!.fetch(request);
      if (response.ok && new URL(request.url).pathname.endsWith(`/${drop}`)) {
        drop = undefined; await response.body?.cancel();
        throw new Error('Injected lost acknowledgment after the production billing controller committed.');
      }
      return response;
    } };
  } } as unknown as DurableObjectNamespace;
});

afterEach(() => { vi.useRealTimers(); db?.close(); });

test('lost essential reservation acknowledgments retain the hold; provably unused expiry settles before a new generation', async () => {
  const storage = new MemoryStorage();
  let helper = new HelperBudget(storage as unknown as DurableObjectStorage, env, identity);
  drop = 'essential-reserve';
  await expect(helper.reserve()).rejects.toMatchObject({ code: 'admission_unavailable' });
  const original = (await helper.read())!;
  expect(original.phase).toBe('reserving');
  const quote = db.sqlite.prepare('SELECT quote_json FROM billing_helper_intents WHERE allocation_id=?').get(original.id)!;
  expect(JSON.parse(String(quote.quote_json)).maximum_operations).toBe(original.maximum_operations);
  expect((await snapshot()).control.active_slots).toBe(1);
  const competitor = new HelperBudget(new MemoryStorage() as unknown as DurableObjectStorage, env, 'b'.repeat(64));
  await expect(competitor.reserve()).rejects.toMatchObject({ code: 'essential_capacity_busy' });
  // A restart must replay the original profile, even if operator defaults changed.
  env.GIT_HELPER_PROFILE = 'changed-profile-must-not-replace-an-intent';
  env.GIT_HELPER_OPERATIONS = '17';
  helper = new HelperBudget(storage as unknown as DurableObjectStorage, env, identity);
  vi.setSystemTime(originTime + 301_000);
  await expect(helper.reserve()).rejects.toMatchObject({ code: 'git_budget_expired' });
  expect(await helper.read()).toMatchObject({ id: original.id, phase: 'settled', termination_kind: 'never_allocated', egress_bytes: 0 });
  const unused = await snapshot();
  expect(unused.control.active_slots).toBe(0);
  expect(unused.budgets.every(budget => budget.reserved_units === '0' && budget.settled_units === '0')).toBe(true);
  delete env.GIT_HELPER_PROFILE;
  const next = await helper.reserve();
  expect(next.id).not.toBe(original.id);
  expect(next.phase).toBe('starting');
  expect((await snapshot()).control.active_slots).toBe(1);
});

test('uncertain startup needs destruction and lost settlement replies cannot change a frozen egress receipt', async () => {
  const helper = new HelperBudget(new MemoryStorage() as unknown as DurableObjectStorage, env, identity);
  drop = 'essential-start';
  await expect(helper.reserve()).rejects.toMatchObject({ code: 'admission_unavailable' });
  const uncertain = (await helper.read())!;
  expect(uncertain.phase).toBe('starting');
  await expect(helper.stopped('not-a-destruction-receipt', 'never_allocated')).rejects.toMatchObject({ code: 'git_teardown_unconfirmed' });
  await expect(helper.reserve()).rejects.toMatchObject({ code: 'git_budget_reconciling' });
  await expect(helper.settle()).rejects.toMatchObject({ code: 'git_budget_reconciling' });
  expect((await snapshot()).control.active_slots).toBe(1);
  // The managed-runtime boundary is an explicit fixture receipt. This tests its
  // financial consumer; only the real Container can establish provider teardown.
  vi.setSystemTime(originTime + 10_000);
  await helper.stopped(`container:${identity}:${uncertain.id}:destroyed`);
  await helper.settle();
  const running = await helper.reserve();
  await helper.running();
  await helper.operation(running.id, 1, true);
  await helper.bytes(running.id, 'unfinished-response', 512);
  vi.setSystemTime(originTime + 11_000);
  await helper.stopped(`container:${identity}:${running.id}:destroyed`);
  drop = 'essential-settle';
  await expect(helper.settle()).rejects.toMatchObject({ code: 'admission_unavailable' });
  const settled = await snapshot();
  expect(settled.control.active_slots).toBe(0);
  expect(settled.budgets.every(budget => budget.reserved_units === '0')).toBe(true);
  expect(settled.budgets.some(budget => BigInt(budget.settled_units) > 0n)).toBe(true);
  await helper.finishStream(running.id, 'unfinished-response', 64);
  expect((await helper.read())?.egress_bytes).toBe(512);
  await helper.settle();
  expect(await helper.read()).toMatchObject({ id: running.id, phase: 'settled', egress_bytes: 512 });
  expect(await snapshot()).toEqual(settled);
});

function snapshot(): Promise<Snapshot> { return admissionRequest(env, 'capacity:slice_git_essential', 'snapshot'); }

class MemoryStorage {
  private values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T>(options: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([key]) => key.startsWith(options.prefix ?? '') && key > (options.startAfter ?? '')).slice(0, options.limit ?? Infinity)
      .map(([key, value]) => [key, structuredClone(value) as T]));
  }
  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const before = structuredClone(this.values);
      try { return await callback(this); } catch (error) { this.values = before; throw error; }
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async setAlarm(): Promise<void> {}
}
