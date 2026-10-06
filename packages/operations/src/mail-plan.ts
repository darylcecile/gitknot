import { many, newId, now, one, registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { EventRecord, Repository } from '@gitknot/core';
import { completion, consumeOnce } from './durable.ts';
import { operationFenceGuard } from './metadata-fence.ts';
import { placementGuard } from './ownership.ts';
import type { OperationsBindings } from './types.ts';
import { principalById } from './authorization.ts';
import { executionEventRequirements } from './execution-audience.ts';

export interface MailRecipient {
  delivery_id: string; user_id: string | null; account_id: string | null; repo_id: string | null;
  template: string; reference_id: string; generation: number;
}

export async function mailRecipient(event: EventRecord, template: string, reference: string, userId: string | null, generation = 0): Promise<MailRecipient> {
  return { delivery_id: `mail_${(await sha256(`${template}:${reference}:${generation}`)).slice(0, 48)}`, user_id: userId,
    account_id: event.account_id ?? null, repo_id: event.repo_id ?? null, template, reference_id: reference, generation };
}

async function captureRecipients(env: OperationsBindings, event: EventRecord, extra: MailRecipient[], repository: Repository | null): Promise<void> {
  const db = env.DB.withSession('first-primary');
  if (await one(db, 'SELECT 1 FROM mail_fanouts WHERE event_id=?', event.id)) return;
  const inbox = await many<{ id: string; user_id: string }>(db,
    "SELECT id,user_id FROM collaboration_inbox WHERE source_event_id=? AND state='outstanding' ORDER BY id LIMIT 501", event.id);
  if (inbox.length > 500) throw new Error('mail_fanout_limit');
  const candidates = [...extra, ...await Promise.all(inbox.map(row => mailRecipient(event, 'inbox', row.id, row.user_id)))];
  const recipients: MailRecipient[] = [];
  for (const candidate of candidates) {
    if (candidate.user_id) {
      const principal = await principalById(env, candidate.user_id);
      if (!principal || await executionEventRequirements(env, principal, event) === null) continue;
    }
    recipients.push(candidate);
  }
  for (const recipient of recipients) await registerResourceLocator(env, { resource_id: recipient.delivery_id, resource_type: 'delivery',
    repo_id: recipient.repo_id, authority: recipient.template === 'inbox' ? 'repository' : 'identity' });
  await consumeOnce(db, 'mail-membership', event.id, [
    ...await operationFenceGuard(db, repository?.id ?? null), ...placementGuard(db, repository),
    stmt(db, 'INSERT INTO mail_fanouts(event_id,repo_id,authority,recipient_count,created_at) VALUES(?,?,?,?,?)',
      event.id, event.repo_id ?? null, repository ? 'repository' : 'identity', recipients.length, now()),
    stmt(db, `INSERT INTO mail_recipients(event_id,delivery_id,user_id,account_id,repo_id,template,reference_id,generation)
      SELECT ?,json_extract(value,'$.delivery_id'),json_extract(value,'$.user_id'),json_extract(value,'$.account_id'),json_extract(value,'$.repo_id'),
        json_extract(value,'$.template'),json_extract(value,'$.reference_id'),json_extract(value,'$.generation') FROM json_each(?)`, event.id, JSON.stringify(recipients)),
  ]);
}

export async function materializeMailRecipients(env: OperationsBindings, event: EventRecord, extra: MailRecipient[], repository: Repository | null): Promise<void> {
  await captureRecipients(env, event, extra, repository);
  const db = env.DB.withSession('first-primary');
  for (;;) {
    const recipients = await many<MailRecipient>(db, "SELECT * FROM mail_recipients WHERE event_id=? AND state='planned' ORDER BY delivery_id LIMIT 50", event.id);
    if (!recipients.length) break;
    for (const row of recipients) await consumeOnce(db, `mail-recipient:${event.id}`, row.delivery_id, [
      ...await operationFenceGuard(db, repository?.id ?? null), ...placementGuard(db, repository),
      stmt(db, `INSERT INTO mail_deliveries(id,event_id,user_id,account_id,repo_id,template,reference_id,generation,next_attempt_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, row.delivery_id, event.id, row.user_id, row.account_id, row.repo_id,
      row.template, row.reference_id, row.generation, now(), now(), now()),
      stmt(db, "UPDATE mail_recipients SET state='materialized' WHERE event_id=? AND delivery_id=?", event.id, row.delivery_id),
    ]);
  }
  const guard = newId('guard');
  await consumeOnce(db, 'mail', event.id, [
    stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN NOT EXISTS (
      SELECT 1 FROM mail_recipients WHERE event_id=? AND state<>'materialized') THEN 1 ELSE 0 END`, guard, event.id),
    completion(db, 'mail', event.id), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
  ]);
}
