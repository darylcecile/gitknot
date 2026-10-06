import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_SETTINGS = new Set(['CELL_ID', 'EXECUTION_CELL_ID', 'DIRECTORY_CELL_ID', 'IDENTITY_CELL_ID', 'INGRESS_CELL_ID', 'TRUST_ACCOUNT_ID', 'EXECUTION_ACCOUNT_ID', 'SHARDS', 'JURISDICTION', 'PEERS_FILE', 'RECOVERY_MODE', 'EXECUTION_PAUSED', 'GIT_IMAGE', 'SANDBOX_IMAGE', 'EGRESS_IMAGE', 'HOSTED_PROFILES_FILE', 'HOSTED_EXECUTOR_FILE', 'HOSTED_PREVIOUS_KEY_BINDINGS', 'KEK_CURRENT_ID', 'FEDERATION_TRUSTED_ORIGINS_FILE', 'BILLING_PLATFORM_SLICE_ID', 'BILLING_GIT_STORAGE_SLICE_ID', 'BILLING_ESSENTIAL_SLICE_ID']);
const dotenvPath = join(ROOT, '.env');
if (existsSync(dotenvPath)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(dotenvPath, 'utf8')))) {
    const suffix = /^GITKNOT_(?:DEVELOPMENT|STAGING|PRODUCTION)_(.+)$/.exec(name)?.[1];
    if ((['GITKNOT_MODE', 'GITKNOT_STATE_FILE', 'GITKNOT_LOCAL_STATE'].includes(name) || suffix && PUBLIC_SETTINGS.has(suffix)) && process.env[name] === undefined) process.env[name] = value;
  }
}
export const MODES = ['development', 'staging', 'production'] as const;
export type Mode = (typeof MODES)[number];
export const TRUSTED_WORKERS = ['api', 'git', 'background', 'execution', 'secrets', 'egress'] as const;
export const WORKERS = [...TRUSTED_WORKERS, 'hosted'] as const;
export type WorkerRole = (typeof WORKERS)[number];
export type AccountRole = 'trusted' | 'execution';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/);
const accountId = z.string().regex(/^[a-f0-9]{32}$/);
const controlKeyName = z.string().regex(/^HOSTED_CONTROL_KEY(?:_[A-Z0-9]+)*$/);
const callbackKeyName = z.string().regex(/^HOSTED_CALLBACK_KEY(?:_[A-Z0-9]+)*$/);
const remoteExecutorSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  origin: z.string().min(1),
  callback_origin: z.string().min(1),
  producer_id: z.string().regex(/^hosted:[A-Za-z0-9_.:-]{1,160}$/),
  key_binding: controlKeyName.default('HOSTED_CONTROL_KEY'),
  callback_key_binding: callbackKeyName.optional(),
}).strict();
export type RemoteExecutorSettings = z.infer<typeof remoteExecutorSchema>;
const resourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  account_id: accountId,
  kind: z.string().min(1),
  spec_sha256: z.string().optional(),
  observed_at: z.string(),
});

export const stateSchema = z.object({
  version: z.literal(1),
  mode: z.enum(MODES),
  cell_id: identifier,
  execution_cell_id: identifier,
  accounts: z.object({ trusted: accountId.optional(), execution: accountId.optional() }),
  zone_id: accountId.optional(),
  hosted_zone_id: accountId.optional(),
  hosted_zone_name: z.string().optional(),
  resources: z.record(z.string(), resourceSchema),
  images: z.object({ native_git: z.string().optional(), sandbox: z.string().optional(), egress: z.string().optional() }).default({}),
  updated_at: z.string(),
});
export type InfrastructureState = z.infer<typeof stateSchema>;
export type ResourceState = z.infer<typeof resourceSchema>;

export interface Environment {
  mode: Mode;
  cell: string;
  executionCell: string;
  directoryCell: string;
  identityCell: string;
  ingressCell: string;
  peers: { cell_id: string; account_id?: string }[];
  recovery: boolean;
  shardCount: number;
  prefix: string;
  executionPrefix: string;
  statePath: string;
  state: InfrastructureState;
  accounts: { trusted?: string; execution?: string };
  separatedAccounts: boolean;
  remoteExecutor?: RemoteExecutorSettings;
  previousHostedKeyBindings: string[];
  origins: { app: string; api: string; git: string };
  jurisdiction?: 'eu' | 'us';
}

export function parseMode(value: string | undefined): Mode {
  return z.enum(MODES).parse(value ?? process.env.GITKNOT_MODE ?? 'development');
}

export function scopedVariable(mode: Mode, name: string): string | undefined {
  return process.env[`GITKNOT_${mode.toUpperCase()}_${name}`] || undefined;
}

export function stateFile(mode: Mode, cell: string): string {
  return join(ROOT, '.gitknot', 'infra', mode, cell, 'state.json');
}

export function emptyState(mode: Mode, cell: string, executionCell: string): InfrastructureState {
  return { version: 1, mode, cell_id: cell, execution_cell_id: executionCell, accounts: {}, resources: {}, images: {}, updated_at: new Date().toISOString() };
}

export function loadState(path: string, expected: { mode: Mode; cell: string; executionCell: string }): InfrastructureState {
  if (!existsSync(path)) return emptyState(expected.mode, expected.cell, expected.executionCell);
  const state = stateSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (state.mode !== expected.mode || state.cell_id !== expected.cell || state.execution_cell_id !== expected.executionCell) {
    throw new Error(`Infrastructure state ${path} belongs to a different mode or cell.`);
  }
  return state;
}

function configuredAccount(mode: Mode, role: AccountRole, state: InfrastructureState): string | undefined {
  const value = scopedVariable(mode, role === 'trusted' ? 'TRUST_ACCOUNT_ID' : 'EXECUTION_ACCOUNT_ID') ?? state.accounts[role];
  return value ? accountId.parse(value) : undefined;
}

function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('An internal origin must be an HTTPS origin without credentials, a path, or query parameters.');
  }
  return url.origin;
}

function remoteExecutorSettings(mode: Mode, apiOrigin: string): RemoteExecutorSettings | undefined {
  const path = scopedVariable(mode, 'HOSTED_EXECUTOR_FILE');
  if (!path) return undefined;
  if (mode === 'development') throw new Error('The local dev stack uses direct local execution. Use the isolated remote-host HTTP tests for local remote-topology verification; configure real remote origins in staging or production.');
  const settings = remoteExecutorSchema.parse(JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')));
  const origin = httpsOrigin(settings.origin);
  const callback = httpsOrigin(settings.callback_origin);
  if (callback !== apiOrigin) throw new Error('The hosted callback origin must be the configured GitKnot API origin.');
  if (origin === callback) throw new Error('The hosted runtime and trusted callback endpoint must use distinct origins.');
  return { ...settings, origin, callback_origin: callback };
}

export function environment(value?: string): Environment {
  const mode = parseMode(value);
  const cell = identifier.parse(scopedVariable(mode, 'CELL_ID') ?? 'cell-001');
  const executionCell = identifier.parse(scopedVariable(mode, 'EXECUTION_CELL_ID') ?? 'exec-001');
  const directoryCell = identifier.parse(scopedVariable(mode, 'DIRECTORY_CELL_ID') ?? 'cell-001');
  const identityCell = identifier.parse(scopedVariable(mode, 'IDENTITY_CELL_ID') ?? 'cell-001');
  const ingressCell = identifier.parse(scopedVariable(mode, 'INGRESS_CELL_ID') ?? 'cell-001');
  const statePath = process.env.GITKNOT_STATE_FILE ? resolve(ROOT, process.env.GITKNOT_STATE_FILE) : stateFile(mode, cell);
  const state = loadState(statePath, { mode, cell, executionCell });
  const trusted = configuredAccount(mode, 'trusted', state);
  const execution = configuredAccount(mode, 'execution', state) ?? trusted;
  const suffix = mode === 'production' ? 'gitknot.com' : 'staging.gitknot.com';
  const origins = mode === 'development'
    ? { app: 'http://localhost:5173', api: 'http://localhost:8787', git: 'http://localhost:8788' }
    : { app: `https://${suffix}`, api: `https://api.${suffix}`, git: `https://git.${suffix}` };
  const remoteExecutor = remoteExecutorSettings(mode, origins.api);
  if (trusted && execution && trusted !== execution && !remoteExecutor) {
    throw new Error('Separate execution accounts require a mode-specific HOSTED_EXECUTOR_FILE describing the authenticated HTTPS runtime.');
  }
  const previousHostedKeyBindings = z.array(z.union([controlKeyName, callbackKeyName])).max(8).parse(scopedVariable(mode, 'HOSTED_PREVIOUS_KEY_BINDINGS')?.split(',').map(value => value.trim()).filter(Boolean) ?? []);
  const jurisdiction = z.enum(['eu', 'us']).optional().parse(scopedVariable(mode, 'JURISDICTION'));
  const peersFile = scopedVariable(mode, 'PEERS_FILE');
  const peers = z.array(z.object({ cell_id: identifier, account_id: accountId.optional() }).strict()).max(8)
    .parse(peersFile ? JSON.parse(readFileSync(resolve(ROOT, peersFile), 'utf8')) : []);
  if (new Set(peers.map(peer => peer.cell_id)).size !== peers.length || peers.some(peer => peer.cell_id === cell)) throw new Error('Peer cells must be unique and exclude the current cell.');
  if (peers.some(peer => peer.account_id && peer.account_id !== trusted)) throw new Error('Cross-account cell peers require an authenticated remote cell adapter; service bindings cannot cross accounts.');
  return {
    mode, cell, executionCell, directoryCell, identityCell, ingressCell, peers, statePath, state,
    recovery: scopedVariable(mode, 'RECOVERY_MODE') === 'true',
    prefix: `gitknot-${mode}-${cell}`,
    executionPrefix: `gitknot-${mode}-${executionCell}`,
    shardCount: z.coerce.number().int().min(1).max(8).parse(scopedVariable(mode, 'SHARDS') ?? 1),
    accounts: { trusted, execution },
    separatedAccounts: Boolean(trusted && execution && trusted !== execution),
    origins, jurisdiction, remoteExecutor, previousHostedKeyBindings,
  };
}

export function directoryName(env: Environment): string {
  return `gitknot-${env.mode}-${env.directoryCell}-directory`;
}

/** The physical identity home and its D1 name share one authoritative definition. */
export function identityStorage(env: Environment): { key: string; name: string; existing: boolean; cell: string; shard: string } {
  const cell = env.identityCell, shard = 'core-001';
  return { key: env.cell === cell ? `d1.${shard}` : 'd1.identity', name: `gitknot-${env.mode}-${cell}-${shard}`, existing: env.cell !== cell, cell, shard };
}

/** Synthetic local IDs in the v4-shaped format required by cf beta.12's ID matcher. */
export function localDatabaseId(name: string): string {
  const hex = createHash('sha256').update(`gitknot:local-d1:${name}`).digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function workerName(env: Environment, role: WorkerRole): string {
  // Attempt/admission controllers stay cell-local in the trusted account.
  const execution = role === 'hosted';
  return `${execution ? env.executionPrefix : env.prefix}-${role}`;
}

/** Execution controllers are trusted; only the optional hosted runtime owns the execution account. */
export function workerAccount(role: WorkerRole): AccountRole {
  return role === 'hosted' ? 'execution' : 'trusted';
}

export function workerRoles(env: Environment): WorkerRole[] {
  return env.remoteExecutor ? [...WORKERS] : [...TRUSTED_WORKERS];
}

export function executionStorage(env: Environment): { key: string; name: string; account: AccountRole } {
  return env.remoteExecutor
    ? { key: 'r2.hosted-ephemeral', name: resourceName(env, 'hosted-ephemeral', 'execution'), account: 'execution' }
    : { key: 'r2.snapshots', name: resourceName(env, 'snapshots', 'execution'), account: 'trusted' };
}

export function executionContainerName(env: Environment): string {
  return resourceName(env, env.remoteExecutor ? 'hosted-linux-small' : 'linux-small', 'execution');
}

export function buildOutputRoot(account: AccountRole): string {
  return account === 'trusted' ? ROOT : join(ROOT, '.cloudflare', 'accounts', account);
}

export function workerConfigPath(role: WorkerRole): string {
  if (role === 'egress') return join(ROOT, 'infra/egress/cloudflare.config.ts');
  return join(ROOT, role === 'api' ? 'apps/api/cloudflare.config.ts' : `workers/${role}/cloudflare.config.ts`);
}

export function workerSourcePath(role: WorkerRole): string {
  if (role === 'egress') return join(ROOT, 'infra/egress/worker.ts');
  return join(ROOT, role === 'api' ? 'apps/api/src/index.ts' : `workers/${role}/src/index.ts`);
}

export function resourceName(env: Environment, suffix: string, account: AccountRole = 'trusted'): string {
  const name = `${account === 'trusted' ? env.prefix : env.executionPrefix}-${suffix}`;
  if (name.length > 63) throw new Error(`Resource name exceeds the 63-character bucket-safe limit: ${name}`);
  return name;
}

export function coreShards(env: Environment): { binding: string; key: string; name: string; shard: string }[] {
  return Array.from({ length: env.shardCount }, (_, index) => {
    const shard = `core-${String(index + 1).padStart(3, '0')}`;
    return { binding: index === 0 ? 'DB' : `DB_${String(index + 1).padStart(3, '0')}`, key: `d1.${shard}`, name: resourceName(env, shard), shard };
  });
}

export const LOCAL_STATE = resolve(ROOT, process.env.GITKNOT_LOCAL_STATE ?? '.cloudflare/state');
export const CF_VERSION = '1.0.0-beta.12';
export const VITE_PLUGIN_VERSION = '2.0.0-beta.sha-52b0dc0e9';
export const COMPATIBILITY_DATE = '2026-09-30';
