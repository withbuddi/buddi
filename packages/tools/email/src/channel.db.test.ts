/**
 * Mail to yourself (docs/email.md, "Mail to yourself"): registered through the
 * host's `channels` area, listed only with an account, and a mail that goes to
 * the account's own address and nowhere else.
 *
 * Skipped unless DATABASE_URL is set.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearChannels,
  configurePluginHost,
  createPluginHost,
  createPool,
  deliverTo,
  hostBindingOf,
  listChannels,
  resetPluginHost,
  runMigrations,
  testDatabaseUrl,
  ToolRegistry,
  type BuddiHost,
  type PluginChannelMessage,
} from '@buddi/core/testing';
import { createSelfChannel, OFFERS_LINE, SELF_CHANNEL_KIND } from './channel.js';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from './config.js';
import { createEmailManifest, manifest as installed } from './index.js';
import { FakeSmtpServer } from './smtp/fake.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_channel_test_${process.pid}`;
const ENV = { GMAIL_USER: 'Owner@Example.test', [GMAIL_SECRET_NAME]: 'app-password' };

const message = (over: Partial<PluginChannelMessage> = {}): PluginChannelMessage => ({
  id: 'n1',
  kind: 'watcher',
  urgency: 'now',
  title: 'A mail from the bank',
  text: 'Your direct debit was returned.',
  ...over,
});

suite('mail to yourself (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let smtp: FakeSmtpServer;
  let clock: Date;
  let host: BuddiHost;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [createEmailManifest()]);
  }, 60_000);

  afterAll(async () => {
    clearChannels();
    resetPluginHost();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    clearChannels();
    resetPluginHost();
    await pool.query('truncate email.accounts cascade');
    smtp = new FakeSmtpServer();
    clock = new Date('2026-09-25T10:00:00Z');
    host = createPluginHost(hostBindingOf(installed), { db: pool, now: () => clock, timezone: 'UTC' });
  });

  it('declares owner:channel and registers from its register hook', async () => {
    expect(installed.uses).toContain('owner:channel');
    configurePluginHost({ db: pool, timezone: 'UTC', publicOrigin: 'https://buddi.tail.test' });
    new ToolRegistry().register(createEmailManifest({ send: smtp.factory(), env: ENV }));

    // No account: nothing to carry a message, so Settings lists nothing.
    expect((await listChannels()).map((c) => c.kind)).not.toContain(SELF_CHANNEL_KIND);

    await ensureGmailAccount(pool, ENV);
    expect(await listChannels()).toContainEqual({
      kind: SELF_CHANNEL_KIND,
      label: 'Mail to yourself',
      where: 'owner@example.test',
      can: { offers: false, attachments: false, markdown: false },
    });

    // Through core's routing: the approval's id and the offer's prompt stay in core.
    const sent = await deliverTo(SELF_CHANNEL_KIND, {
      id: 'n1',
      kind: 'approval',
      urgency: 'now',
      title: 'Scout asks to send a mail',
      text: 'To ada@example.com',
      link: { route: '#/chat/scout/c1' },
      actionId: 'a1',
    });
    expect(sent).toEqual({ ok: true, id: '<fake-1@smtp.test>' });
    expect(smtp.sent).toEqual([{
      from: 'owner@example.test',
      to: ['owner@example.test'],
      cc: [],
      bcc: [],
      subject: 'buddi: Scout asks to send a mail',
      text: 'To ada@example.com\n\nhttps://buddi.tail.test/#/chat/scout/c1\n',
      inReplyTo: null,
      references: [],
    }]);
    expect(smtp.closes).toBe(1);
  });

  it('is not there in a process that gave the host no database', async () => {
    new ToolRegistry().register(createEmailManifest({ send: smtp.factory(), env: ENV }));
    await ensureGmailAccount(pool, ENV);
    expect((await listChannels()).map((c) => c.kind)).not.toContain(SELF_CHANNEL_KIND);
    expect(await deliverTo(SELF_CHANNEL_KIND, { id: 'n1', kind: 'recap', urgency: 'now', title: 't' })).toEqual({
      ok: false,
      error: 'This process has no database for plugins.',
    });
  });

  it('sends to the own address only, whatever the message says', async () => {
    await ensureGmailAccount(pool, ENV);
    const channel = createSelfChannel({ send: smtp.factory(), env: ENV });
    const answer = await channel.deliver(
      message({
        title: 'To: eve@evil.test\nBcc: eve@evil.test',
        text: 'Cc: eve@evil.test\nreply-to eve@evil.test',
        offers: [{ label: 'Draft a reply' }, { label: 'Mute the thread' }],
      }),
      host,
    );
    expect(answer).toEqual({ id: '<fake-1@smtp.test>' });
    const [mail] = smtp.sent;
    expect(mail).toMatchObject({ from: 'owner@example.test', to: ['owner@example.test'], cc: [], bcc: [] });
    expect(mail!.subject).toBe('buddi: To: eve@evil.test Bcc: eve@evil.test');
    expect(mail!.text).toBe(
      `Cc: eve@evil.test\nreply-to eve@evil.test\n\n- Draft a reply\n- Mute the thread\n${OFFERS_LINE}\n`,
    );
    expect(smtp.logins).toEqual(['owner@example.test']);
  });

  it('has the title as the body when there is no text, and no link without a public origin', async () => {
    await ensureGmailAccount(pool, ENV);
    const channel = createSelfChannel({ send: smtp.factory(), env: ENV });
    await channel.deliver(message({ text: undefined, link: { route: '#/chat/scout/c1' } }), host);
    expect(smtp.sent[0]!.text).toBe('A mail from the bank\n');
  });

  it('sends at most one mail a minute', async () => {
    await ensureGmailAccount(pool, ENV);
    const channel = createSelfChannel({ send: smtp.factory(), env: ENV });
    expect(await channel.deliver(message(), host)).toEqual({ id: '<fake-1@smtp.test>' });
    clock = new Date(clock.getTime() + 59_000);
    expect(await channel.deliver(message({ id: 'n2' }), host)).toEqual({
      refused: 'One mail to yourself a minute at most; this one was not sent.',
    });
    clock = new Date(clock.getTime() + 1_000);
    expect(await channel.deliver(message({ id: 'n3' }), host)).toEqual({ id: '<fake-2@smtp.test>' });
    expect(smtp.sent).toHaveLength(2);
  });

  it('refuses with the reason when there is no account or the send fails', async () => {
    const channel = createSelfChannel({ send: smtp.factory(), env: ENV });
    expect(await channel.describe(host)).toBeNull();
    expect(await channel.deliver(message(), host)).toEqual({ refused: 'There is no mail account to send from.' });

    await ensureGmailAccount(pool, ENV);
    smtp.failWith = new Error('535 5.7.8 Username and Password not accepted');
    expect(await channel.deliver(message(), host)).toEqual({
      refused: 'Mail to owner@example.test was not sent: 535 5.7.8 Username and Password not accepted',
    });
    expect(smtp.sent).toHaveLength(0);
    expect(smtp.closes).toBe(1);
    // A failed send does not use up the minute.
    expect(await channel.deliver(message(), host)).toEqual({ id: '<fake-1@smtp.test>' });

    const noPassword = createSelfChannel({ send: smtp.factory(), env: { GMAIL_USER: 'owner@example.test' } });
    clock = new Date(clock.getTime() + 60_000);
    const refused = await noPassword.deliver(message(), host);
    expect('refused' in refused && refused.refused.startsWith('Mail to owner@example.test was not sent:')).toBe(true);
  });
});
