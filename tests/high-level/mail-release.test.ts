import { expect, it } from 'vitest';
import { eventStatement, many, now, one, sha256, stmt } from '../../packages/core/src/index.ts';
import { scheduleMail, deliverMail } from '../../packages/operations/src/mail.ts';
import { sourceEvent } from '../../packages/operations/src/durable.ts';
import { operationById } from '../../packages/operations/src/lifecycle.ts';
import { submitShardMove } from '../../packages/operations/src/move-request.ts';
import { runShardMove } from '../../packages/operations/src/movement.ts';
import { moveFixture } from '../support/move-fixture.ts';

it.each(['colocated', 'remote'] as const)('fences late identity user-state edits in the actual %s mail release path', async location => {
  const test = await moveFixture();
  try {
    if (location === 'remote') {
      await test.initializeGit();
      const response = await submitShardMove(test.env, { repo_id: test.repoId, expected_epoch: 1,
        target_cell_id: test.target.CELL_ID, target_shard_id: test.target.SHARD_ID }, false);
      const operation = await operationById(test.env, (await response.json() as { id: string }).id);
      await runShardMove(test.env, operation);
    }
    const env = location === 'remote' ? test.target : test.env, db = env.DB;
    const sent: string[] = [];
    let requestIndex = 0;
    env.EMAIL = { send: async message => { sent.push(message.text); return { messageId: `mail-${sent.length}` }; } };
    const call = (method: string, path: string, body?: unknown, revision?: number) => (test.env.API as Fetcher).fetch(new Request(`${test.env.API_ORIGIN}${path}`, {
      method, headers: { authorization: `Bearer ${test.token}`, 'idempotency-key': `mail-witness-${++requestIndex}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const identityBatch = test.source.db.batch.bind(test.source.db);
    for (const change of ['unchanged', 'mute', 'snooze', 'membership'] as const) {
      const itemId = `iss_mail_${change}`, inboxId = `inbox_mail_${change}`, eventId = `evt_mail_${change}`, at = now();
      await db.batch([
        stmt(db, `INSERT INTO collaboration_items(id,repo_id,kind,number,title,markdown,author_id,state,created_at,updated_at)
          SELECT ?,?,'issue',COALESCE(MAX(number),0)+1,?,'Current mail source',?,'open',?,? FROM collaboration_items WHERE repo_id=? AND kind='issue'`,
        itemId, test.repoId, `Mail witness ${change}`, test.actor.id, at, at, test.repoId),
        stmt(db, 'INSERT INTO issues(id,repo_id) VALUES(?,?)', itemId, test.repoId),
        stmt(db, `INSERT INTO collaboration_document_versions(id,repo_id,resource_kind,resource_id,document_revision,title,markdown,sha256,actor_id,created_at)
          VALUES(?,?,'issue',?,1,?,'Current mail source',?,?,?)`, `doc_mail_${change}`, test.repoId, itemId, `Mail witness ${change}`, await sha256('Current mail source'), test.actor.id, at),
        stmt(db, 'INSERT INTO collaboration_mentions(repo_id,resource_id,document_revision,user_id,created_at) VALUES(?,?,1,?,?)', test.repoId, itemId, test.actor.id, at),
        eventStatement(db, { id: eventId, type: 'issue.created', resource_id: itemId, resource_revision: 1, repo_id: test.repoId, account_id: test.accountId, actor_id: test.actor.id }),
        stmt(db, `INSERT INTO collaboration_inbox(id,user_id,repo_id,item_id,reason,source_id,source_event_id,created_at,updated_at)
          VALUES(?,?,?,?,'mention',?,?,?,?)`, inboxId, test.actor.id, test.repoId, itemId, itemId, eventId, at, at),
      ]);
      const subscription = await call('POST', '/v1/subscriptions', { repo_id: test.repoId, item_id: itemId, mode: 'watching', digest: 'off' });
      expect(subscription.status, await subscription.clone().text()).toBe(201);
      const saved = await subscription.json() as { id: string; revision: number };
      await scheduleMail(env, (await sourceEvent(db, eventId))!);
      const delivery = (await one<{ id: string }>(db, 'SELECT id FROM mail_deliveries WHERE event_id=?', eventId))!;
      let injected = false;
      test.source.db.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        const release = statements.some(statement => (statement as unknown as { parameters: unknown[] }).parameters.includes('mail.release_authorized'));
        if (!injected && change !== 'unchanged' && release) {
          injected = true;
          const response = change === 'mute' ? await call('PATCH', `/v1/subscriptions/${saved.id}`, { mode: 'ignored' }, saved.revision)
            : change === 'snooze' ? await call('PATCH', `/v1/inbox/${inboxId}`, { snoozed_until: new Date(Date.now() + 3600_000).toISOString() }, 1)
            : await call('POST', '/v1/subscriptions', { repo_id: test.repoId, mode: 'watching', digest: 'daily' });
          expect(response.status, await response.clone().text()).toBe(change === 'membership' ? 201 : 200);
        }
        return identityBatch<T>(statements);
      };
      const before = sent.length;
      await deliverMail(env, delivery.id);
      test.source.db.batch = identityBatch;
      if (change === 'unchanged') {
        expect(sent).toHaveLength(before + 1);
        expect(sent.at(-1)).toContain('Mail witness unchanged');
        expect(await one(db, 'SELECT state FROM mail_deliveries WHERE id=?', delivery.id)).toEqual({ state: 'accepted' });
      } else {
        expect(injected).toBe(true);
        expect(sent).toHaveLength(before);
        expect(await one(db, 'SELECT provider_message_id,authorized_payload_sha256 FROM mail_deliveries WHERE id=?', delivery.id))
          .toEqual({ provider_message_id: null, authorized_payload_sha256: null });
        for (const binding of [test.env.DB, env.DB]) expect(await many(binding,
          "SELECT id FROM outbox WHERE type='mail.release_authorized' AND resource_id=?", delivery.id)).toEqual([]);
      }
    }
  } finally { await test.close(); }
}, 120_000);
