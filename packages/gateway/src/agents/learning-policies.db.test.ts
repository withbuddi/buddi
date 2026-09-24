/**
 * Learning step 3: a plugin proposes a policy through core, and the owner's
 * keep or discard comes back to that plugin (docs/specs/learning.md §2 item 3).
 *
 * What this file holds the gateway to: keeping a policy calls the plugin's own
 * apply and a discard its revoke; a plugin with no apply is refused cleanly
 * and the card stays open; the email plugin's old proposed rows move to core
 * on start; and — acceptance 3 — a rule the email plugin learned from triage
 * sits in the same inbox as a skill an agent proposed.
 */
import {
  createPool,
  getProposal,
  listOpenProposals,
  proposePolicy,
  runMigrations,
  ToolRegistry,
  type PluginManifest,
  type Proposal,
  type CoreToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME, loadPolicies, manifest as emailManifest } from '@buddi/tool-email';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adoptPluginPolicies, createLearningManifest } from './learning.js';
import { discardProposalFromWeb, keepProposalFromWeb, readProposals } from '../web/proposals.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_learning_policy_test_${process.pid}`;
const NOW = new Date('2026-09-23T12:00:00Z');
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };

/** A plugin that applies rules, recording what it was asked. */
function rulesPlugin(calls: string[]): PluginManifest {
  return {
    name: 'rules',
    version: '0.1.0',
    schema: 'rules',
    migrationsDir: '',
    tools: [],
    policies: {
      async apply(p: Proposal) {
        calls.push(`apply ${p.id}`);
        return p.payload.action === 'refuse' ? { ok: false, note: 'that rule cannot be written.' } : { ok: true, note: 'Written as rule 7.' };
      },
      async revoke(p: Proposal) {
        calls.push(`revoke ${p.id}`);
        return { note: 'Nothing was held.' };
      },
    },
  };
}

/** A plugin that proposes rules but registered no way to apply them. */
const silentPlugin: PluginManifest = { name: 'silent', version: '0.1.0', schema: 'silent', migrationsDir: '', tools: [] };

suite('learned policies through core (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  let calls: string[];
  let registry: ToolRegistry;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [emailManifest]);
    ctx = { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC' };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.proposals, core.events');
    await pool.query('truncate email.events, email.policies, email.triage, email.messages, email.folders, email.accounts cascade');
    calls = [];
    registry = new ToolRegistry();
    registry.register(rulesPlugin(calls));
    registry.register(silentPlugin);
    registry.register(emailManifest);
    registry.register(createLearningManifest(registry));
  });

  const deps = () => ({ pool, registry, ctx, now: () => NOW });
  const propose = async (plugin: string, action = 'ignore') => {
    const made = await proposePolicy(
      pool,
      null,
      { plugin, matcher: { sender: `${action}@x.test` }, action, verdicts: [1, 2, 3], why: 'three times', sources: [] },
      NOW,
    );
    if (!made.ok) throw new Error(made.message);
    return made.proposal;
  };

  it('keeps a policy by calling its plugin\'s apply, and discards one through its revoke', async () => {
    const kept = await propose('rules');
    const result = await keepProposalFromWeb(deps(), kept.id, undefined);
    expect(result).toMatchObject({ ok: true, body: { applied: true, note: 'Written as rule 7.' } });
    expect(calls).toEqual([`apply ${kept.id}`]);
    expect((await getProposal(pool, kept.id))?.state).toBe('kept');

    const dropped = await propose('rules', 'notify');
    expect((await discardProposalFromWeb(deps(), dropped.id, 'no')).ok).toBe(true);
    expect(calls).toEqual([`apply ${kept.id}`, `revoke ${dropped.id}`]);
  });

  it('refuses a keep the plugin refuses, and a plugin with no apply, leaving the card open', async () => {
    const refused = await propose('rules', 'refuse');
    const a = await keepProposalFromWeb(deps(), refused.id, undefined);
    expect(a).toMatchObject({ ok: false, status: 409, body: { error: 'Not applied: that rule cannot be written.' } });
    expect((await getProposal(pool, refused.id))?.state).toBe('open');

    const orphan = await propose('silent');
    const b = await keepProposalFromWeb(deps(), orphan.id, undefined);
    expect(b).toMatchObject({ ok: false, status: 409 });
    expect(!b.ok && b.body.error).toMatch(/silent plugin is not installed here or does not apply rules/);
    expect((await getProposal(pool, orphan.id))?.state).toBe('open');
    // A discard stands whatever there is to tell.
    expect((await discardProposalFromWeb(deps(), orphan.id, undefined)).ok).toBe(true);
  });

  it('moves the email plugin\'s old proposed rows to core on start, once', async () => {
    const account = await ensureGmailAccount(pool, ENV);
    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       values ($1, 'sender', 'ads@shop.test', 'ignore', '{}'::jsonb, 'learned', true),
              ($1, 'sender', 'kept@shop.test', 'ignore', '{}'::jsonb, 'learned', false)`,
      [account!.id],
    );
    expect(await adoptPluginPolicies(pool, registry.manifests(), NOW)).toEqual({ email: 1 });
    expect(await adoptPluginPolicies(pool, registry.manifests(), NOW)).toEqual({ email: 0 });
    const open = await listOpenProposals(pool);
    expect(open.map((p) => p.payload.matcher)).toEqual([expect.objectContaining({ sender: 'ads@shop.test' })]);
    expect((await loadPolicies(pool, account!.id)).map((p) => p.matcher)).toEqual(['kept@shop.test']);
  });

  it('acceptance 3: an email learned rule appears in the same inbox as a skill proposal, and keeping it writes the rule', async () => {
    const account = await ensureGmailAccount(pool, ENV);
    const { rows: folder } = await pool.query(
      `insert into email.folders (account_id, name) values ($1, 'INBOX') returning id`,
      [account!.id],
    );
    const run = {
      ...ctx,
      agentId: 'mail-triage',
      conversationId: undefined,
      provenance: () => ({ runId: 'run-t', turn: 1, step: 1, sources: [] }),
    };
    for (let i = 1; i <= 3; i += 1) {
      const { rows } = await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
            subject, date, snippet, body_text, triage_enqueued_at)
         values ($1, $2, 1, $3, $4, $4, 'news@shop.test', '["owner@example.test"]'::jsonb,
                 $5, $6, '', '', now())
         returning id`,
        [account!.id, folder[0].id, i, `<n${i}@shop.test>`, `Offer ${i}`, `2026-09-0${i}T09:00:00Z`],
      );
      const out = await registry.invoke(
        'email.triage_record',
        { messageId: String(rows[0].id), category: 'promo', urgency: 'low', summary: 'ad' },
        run,
      );
      expect(out.ok).toBe(true);
    }
    const skill = await registry.invoke(
      'learning.propose_skill',
      { name: 'Check a bank balance', when: 'When asked.', steps: '1. Open the bank.', why: 'Twice this week.' },
      { ...ctx, agentId: 'advisor', provenance: () => ({ runId: 'run-s', turn: 2, step: 1, sources: [] }) },
    );
    expect(skill.ok && skill.output).toMatchObject({ ok: true });

    const inbox = await readProposals(pool, NOW);
    expect(inbox.open.map((p) => [p.kind, p.title]).sort()).toEqual([
      ['policy', 'Rule for email: ignore'],
      ['skill', 'Skill: Check a bank balance'],
    ]);
    const rule = inbox.open.find((p) => p.kind === 'policy')!;
    expect(rule).toMatchObject({ agent: 'mail-triage', untrusted: true, runId: 'run-t' });
    expect(rule.sources).toEqual([
      'mail "Offer 3" from news@shop.test (email.triage_record)',
      'mail "Offer 2" from news@shop.test (email.triage_record)',
      'mail "Offer 1" from news@shop.test (email.triage_record)',
    ]);
    expect(await loadPolicies(pool, account!.id)).toEqual([]);

    const kept = await keepProposalFromWeb(deps(), rule.id, undefined);
    expect(kept).toMatchObject({ ok: true, body: { applied: true } });
    const rules = await loadPolicies(pool, account!.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ matcher: 'news@shop.test', action: 'ignore', origin: 'learned', proposed: false });
  });
});
