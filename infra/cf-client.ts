import { cf, offlineEnvironment } from './process.ts';
import { scopedVariable, type AccountRole, type Environment } from './environment.ts';

export type JsonObject = Record<string, unknown>;

export function object(value: unknown, description = 'Cloudflare response'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} must be an object.`);
  return value as JsonObject;
}

export function result(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'result' in value) return (value as JsonObject).result;
  return value;
}

export function records(value: unknown): JsonObject[] {
  const data = result(value);
  if (Array.isArray(data)) return data.map(item => object(item));
  const record = object(data);
  for (const key of ['items', 'buckets', 'queues', 'namespaces', 'subdomains', 'scripts', 'workflows', 'applications', 'subscriptions']) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).map(item => object(item));
  }
  throw new Error('Cloudflare returned an unrecognized list shape; refusing to treat it as an empty account.');
}

const READ_COMMANDS = new Set([
  'zones list', 'zones settings get', 'dns records list', 'd1 list', 'd1 get', 'r2 buckets list', 'r2 buckets get',
  'queues list', 'queues get', 'artifacts namespaces list', 'rulesets account-rulesets list', 'rulesets account-rulesets get',
  'email-sending subdomains list', 'email-sending limits get', 'logpush account-jobs list',
  'r2 buckets lifecycle get', 'r2 buckets locks get', 'r2 buckets domains managed list',
  'queues subscriptions list', 'workers secrets list',
  'workers scripts search', 'durable-objects namespaces list', 'workflows list', 'containers applications list',
]);
const WRITE_COMMANDS = new Set([
  'd1 create', 'd1 update', 'r2 buckets create', 'r2 buckets edit', 'queues create', 'queues edit', 'artifacts namespaces create',
  'r2 buckets lifecycle update', 'r2 buckets locks update', 'r2 buckets domains managed update',
  'rulesets account-rulesets create', 'rulesets account-rulesets update',
  'email-sending subdomains create', 'logpush account-jobs create', 'workers secrets bulk',
  'queues subscriptions create',
]);

function commandName(args: readonly string[], allowed: ReadonlySet<string>): string {
  const found = [...allowed].find(name => name.split(' ').every((part, index) => args[index] === part));
  if (!found) throw new Error(`Command is outside the infrastructure adapter's allowlist: cf ${args.slice(0, 5).join(' ')}`);
  return found;
}

export class CloudflareClient {
  constructor(private readonly environment: Environment, private readonly allowApply = false) {}

  private credentials(account: AccountRole): NodeJS.ProcessEnv {
    const id = this.environment.accounts[account];
    if (!id) throw new Error(`Set GITKNOT_${this.environment.mode.toUpperCase()}_${account === 'trusted' ? 'TRUST' : 'EXECUTION'}_ACCOUNT_ID before resolving resources.`);
    const sharedAccountToken = account === 'execution' && this.environment.accounts.execution === this.environment.accounts.trusted
      ? scopedVariable(this.environment.mode, 'TRUST_API_TOKEN') : undefined;
    const token = scopedVariable(this.environment.mode, account === 'trusted' ? 'TRUST_API_TOKEN' : 'EXECUTION_API_TOKEN') ?? sharedAccountToken ?? process.env.CLOUDFLARE_API_TOKEN;
    if (!token) throw new Error('The explicit resource operation requires an operator-supplied API token. This tool does not start login.');
    return { ...offlineEnvironment(), CLOUDFLARE_ACCOUNT_ID: id, CLOUDFLARE_API_TOKEN: token };
  }

  async read(args: readonly string[], account: AccountRole = 'trusted'): Promise<unknown> {
    commandName(args, READ_COMMANDS);
    return this.run(args, account);
  }

  async apply(args: readonly string[], account: AccountRole = 'trusted'): Promise<unknown> {
    if (!this.allowApply) throw new Error('Mutating calls are disabled for the read-only planning client.');
    commandName(args, WRITE_COMMANDS);
    return this.run(args, account);
  }

  private async run(args: readonly string[], account: AccountRole): Promise<unknown> {
    try {
      const output = await cf([...args, '--mode', this.environment.mode], { capture: true, env: this.credentials(account), timeout: 120_000 });
      return output.trim() ? JSON.parse(output) : null;
    } catch (error) {
      // The CLI may repeat a request body on failure (notably secret changes).
      // Only resource command names/status are safe to send to operator logs.
      const message = error instanceof Error ? error.message : String(error);
      const status = /(?:HTTP|status(?: code)?)[ :]*(\d{3})/i.exec(message)?.[1];
      throw new Error(`cf ${args.filter(part => !part.startsWith('--')).slice(0, 3).join(' ')} failed${status ? ` (HTTP ${status})` : ''}. The operation did not produce a verified result.`, { cause: error });
    }
  }
}
