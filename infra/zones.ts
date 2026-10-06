import { CloudflareClient, object, records, type JsonObject } from './cf-client.ts';
import type { AccountRole, Environment } from './environment.ts';

export interface OwnedZone { id: string; name: string; account_id: string }

function ownedZone(value: JsonObject, accountId: string): OwnedZone {
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || value.status !== 'active') throw new Error('The selected Cloudflare zone is missing or inactive.');
  if (object(value.account, 'Zone account').id !== accountId) throw new Error('The selected zone belongs to a different Cloudflare account.');
  return { id: value.id, name: value.name, account_id: accountId };
}

export async function resolveNamedZone(client: CloudflareClient, env: Environment, account: AccountRole, name: string): Promise<OwnedZone> {
  const accountId = env.accounts[account];
  if (!accountId) throw new Error(`Choose the ${account} account before resolving its zone.`);
  const values = records(await client.read(['zones', 'list', '--account-id', accountId, '--name', name, '--per-page', '50'], account));
  const matched = values.filter(zone => zone.name === name);
  if (matched.length !== 1) throw new Error(`Expected one existing ${name} zone owned by the ${account} account.`);
  return ownedZone(matched[0]!, accountId);
}

/** Custom Domains must be attached in the account that owns the serving Worker. */
export async function resolveHostnameZone(client: CloudflareClient, env: Environment, account: AccountRole, hostname: string): Promise<OwnedZone> {
  const accountId = env.accounts[account];
  if (!accountId) throw new Error(`Choose the ${account} account before resolving its ingress.`);
  const candidates: JsonObject[] = [];
  for (let page = 1; page <= 10_000; page++) {
    const values = records(await client.read(['zones', 'list', '--account-id', accountId, '--per-page', '50', '--page', String(page)], account));
    candidates.push(...values.filter(zone => typeof zone.name === 'string' && (hostname === zone.name || hostname.endsWith(`.${zone.name}`))));
    if (values.length < 50) {
      candidates.sort((a, b) => String(b.name).length - String(a.name).length);
      const selected = candidates[0];
      if (!selected) throw new Error(`${hostname} needs an active zone owned by the ${account} account before a Custom Domain can attach to that Worker.`);
      return ownedZone(selected, accountId);
    }
  }
  throw new Error('Zone discovery exceeded its bounded page count.');
}
