/**
 * `ctx.buddi.secrets` (docs/plugin-host-api.md §4.2, owner-secrets.md
 * §2, §3, §7): the binding found, the target checked by the destination, the
 * rule applied — the kind's `maxRule` included — the first-time card raised
 * through the ordinary approvals path, a foreign kind refused, and no value in
 * any result. Then the migration of a plugin's own vault entry, on a
 * throwaway vault. The database is created by this suite and dropped.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from '../db.js';
import { urlForDatabase } from '../backup/restore.js';
import { testDatabaseUrl } from '../testing/database-url.js';
import { ToolRegistry } from '../registry.js';
import { decideApproval } from '../actions/approvals.js';
import { executeApproved } from '../actions/execute.js';
import { configurePluginHost, createPluginHost, hostBindingOf, resetPluginHost } from '../host/build.js';
import type { BuddiHost, SecretDestination } from '../host/types.js';
import type { PluginManifest, CoreToolContext } from '../tools.js';
import { createMemoryVault } from '../vault/memory.js';
import { ownerSecretVaultName, type Vault } from '../vault/types.js';
import { createSecretsManifest } from './approval.js';
import { registerSecretDestination, resetSecretDestinations } from './destinations.js';
import { adoptVaultEntry, findSecret, putOwnerSecret } from './store.js';
import { useOwnerSecret } from './use.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_secrets_${process.pid}`;
const VALUE = 'hunter2-correct-horse';

suite('ctx.buddi.secrets', () => {
  let admin: Pool;
  let pool: Pool;
  let vault: Vault;
  let registry: ToolRegistry;
  const now = new Date('2026-09-24T12:00:00Z');
  /** What each destination was handed, by use id. */
  const delivered = new Map<string, string>();

  const destination = (kind: string, maxRule: SecretDestination['maxRule']): SecretDestination => ({
    kind,
    maxRule,
    checkTarget: (target, bound) => target === bound,
    describe: (target) => `the ${kind} ${String(target)}`,
    deliver: (value, _target, { use }) => {
      delivered.set(use, value);
    },
  });

  const manifest = (name: string, destinations: SecretDestination[]): PluginManifest => ({
    name,
    version: '1.0.0',
    schema: name,
    migrationsDir: '',
    tools: [],
    uses: ['secrets'],
    destinations,
  });

  const facts = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({
    db: pool,
    ownerId: 'owner',
    now: () => now,
    timezone: 'UTC',
    agentId: 'assistant',
    ...over,
  });

  const hostFor = (m: PluginManifest, over: Partial<CoreToolContext> = {}): BuddiHost =>
    createPluginHost(hostBindingOf(m), facts(over));

  const mail = manifest('mail', [
    destination('mail.account', 'pre-approved'),
    destination('mail.token', 'first-time'),
    destination('mail.card', 'every-time'),
  ]);
  const other = manifest('other', [destination('other.account', 'pre-approved')]);

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  beforeEach(async () => {
    vault = createMemoryVault();
    configurePluginHost({ vault });
    registry = new ToolRegistry();
    registry.register(createSecretsManifest());
    registry.register(mail);
    registry.register(other);
    delivered.clear();
    await pool.query('truncate core.secrets, core.secret_uses cascade');
  });

  afterEach(() => {
    resetPluginHost();
    resetSecretDestinations();
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists "${DB}"`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  const owner = (): BuddiHost => hostFor(mail, { agentId: 'owner' });

  it('delivers a pre-approved binding, answers a use id and never the value', async () => {
    await owner().secrets!.put('Mailbox', VALUE, [{ kind: 'mail.account', target: 'acct-1', rule: 'pre-approved' }]);
    const secret = (await findSecret(pool, 'Mailbox'))!;
    expect(await vault.get(ownerSecretVaultName(secret.id))).toBe(VALUE);

    const host = hostFor(mail);
    const result = await host.secrets!.use('Mailbox', 'mail.account', 'acct-1');
    expect(result).toEqual({ done: true, use: expect.any(String) });
    expect(delivered.get((result as { use: string }).use)).toBe(VALUE);

    const listed = await host.secrets!.list();
    expect(listed).toEqual([
      expect.objectContaining({
        name: 'Mailbox',
        bindings: [expect.objectContaining({ kind: 'mail.account', target: 'acct-1', heldByPlugin: true })],
        lastUse: expect.objectContaining({ kind: 'mail.account', outcome: 'held', agentId: 'assistant' }),
      }),
    ]);
    // No value anywhere a caller or the database can read it back.
    expect(JSON.stringify([result, listed])).not.toContain(VALUE);
    const { rows } = await pool.query(`select * from core.secret_uses`);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
    expect(rows[0]).toMatchObject({ outcome: 'held', plugin: 'mail', secret_name: 'Mailbox' });
    // The area has no read path.
    expect((host.secrets as unknown as Record<string, unknown>).get).toBeUndefined();
  });

  it('refuses a target the destination does not accept, and an unknown name, before any card', async () => {
    await owner().secrets!.put('Mailbox', VALUE, [{ kind: 'mail.account', target: 'acct-1', rule: 'pre-approved' }]);
    const host = hostFor(mail);
    expect(await host.secrets!.use('Mailbox', 'mail.account', 'acct-2')).toEqual({
      refused: '"Mailbox" is not bound to the mail.account acct-2.',
    });
    expect(await host.secrets!.use('Nope', 'mail.account', 'acct-1')).toEqual({ refused: 'There is no secret named "Nope".' });
    // Bound to a kind, not to another of the same plugin's kinds.
    expect(await host.secrets!.use('Mailbox', 'mail.token', 'acct-1')).toEqual({
      refused: '"Mailbox" is not bound to the mail.token acct-1.',
    });
    expect(delivered.size).toBe(0);
    const { rows } = await pool.query(`select count(*)::int as n from core.actions where tool = 'secrets.use'`);
    expect(rows[0].n).toBe(0);
  });

  it("refuses a kind that is not the asking plugin's, and one nobody registered", async () => {
    await owner().secrets!.put('Mailbox', VALUE, [{ kind: 'mail.account', target: 'acct-1', rule: 'pre-approved' }]);
    const intruder = hostFor(other);
    expect(await intruder.secrets!.use('Mailbox', 'mail.account', 'acct-1')).toEqual({
      refused: "mail.account is mail's destination, not other's.",
    });
    expect(await intruder.secrets!.use('Mailbox', 'other.nothing', 'acct-1')).toEqual({
      refused: 'There is no secret destination other.nothing.',
    });
    expect(delivered.size).toBe(0);
    // Nor may it register one in another's namespace, list the other's
    // secrets, or bind one to a kind not its own.
    expect(() => intruder.secrets!.registerDestination(destination('mail.fake', 'pre-approved'))).toThrow(/only as other\./);
    expect(() => registerSecretDestination('other', destination('mail.fake', 'pre-approved'))).toThrow();
    expect(await intruder.secrets!.list()).toEqual([]);
    await expect(
      hostFor(other, { agentId: 'owner' }).secrets!.put('X', VALUE, [{ kind: 'mail.account', target: 'a', rule: 'pre-approved' }]),
    ).rejects.toThrow(/its own destinations/);
    await expect(hostFor(other, { agentId: 'owner' }).secrets!.delete('Mailbox')).rejects.toThrow(/not other's alone/);
  });

  it('lets only the owner write, and never returns a value from a write', async () => {
    await expect(
      hostFor(mail).secrets!.put('Mailbox', VALUE, [{ kind: 'mail.account', target: 'acct-1', rule: 'pre-approved' }]),
    ).rejects.toThrow(/Only the owner/);
    const host = owner();
    expect(await host.secrets!.put('Mailbox', VALUE, [{ kind: 'mail.account', target: 'acct-1', rule: 'pre-approved' }])).toBeUndefined();
    expect(await host.secrets!.rename('Mailbox', 'Work mailbox')).toBe(true);
    expect(await host.secrets!.rebind('Work mailbox', [{ kind: 'mail.account', target: 'acct-9', rule: 'pre-approved' }])).toBe(true);
    expect(await hostFor(mail).secrets!.use('Work mailbox', 'mail.account', 'acct-1')).toHaveProperty('refused');
    expect(await hostFor(mail).secrets!.use('Work mailbox', 'mail.account', 'acct-9')).toHaveProperty('done', true);
    const secret = (await findSecret(pool, 'Work mailbox'))!;
    expect(await host.secrets!.delete('Work mailbox')).toBe(true);
    expect(await vault.get(ownerSecretVaultName(secret.id))).toBeNull();
    expect(await host.secrets!.delete('Work mailbox')).toBe(false);
  });

  it("applies the kind's maxRule: a pre-approved binding on a first-time kind asks once, through an approval", async () => {
    await owner().secrets!.put('Token', VALUE, [{ kind: 'mail.token', target: 'api', rule: 'pre-approved' }]);
    const host = hostFor(mail);

    const first = await host.secrets!.use('Token', 'mail.token', 'api');
    expect(first).toEqual({ pending: expect.any(String) });
    const actionId = (first as { pending: string }).pending;
    // Asking again while the owner decides raises no second card.
    expect(await host.secrets!.use('Token', 'mail.token', 'api')).toEqual({ pending: actionId });
    const { rows: actions } = await pool.query(
      `select a.tool, a.preview, ap.state from core.actions a join core.approvals ap on ap.action_id = a.id`,
    );
    expect(actions).toEqual([
      expect.objectContaining({ tool: 'secrets.use', state: 'pending', preview: expect.stringContaining('mail asks to use your secret "Token"') }),
    ]);
    expect(JSON.stringify(actions)).not.toContain(VALUE);
    expect(delivered.size).toBe(0);

    // The owner approves on any surface; the executor runs core's tool.
    expect((await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'web', now })).ok).toBe(true);
    const executed = await executeApproved(pool, { actionId, registry, ctx: facts(), worker: 'test', now });
    expect(executed).toMatchObject({ ok: true });

    expect(await host.secrets!.use('Token', 'mail.token', 'api')).toHaveProperty('done', true);
    // First time only: the next use needs nobody.
    expect(await host.secrets!.use('Token', 'mail.token', 'api')).toHaveProperty('done', true);
    expect(delivered.size).toBe(2);
    const { rows } = await pool.query(`select count(*)::int as n from core.actions where canonical_args->>'secret' = 'Token'`);
    expect(rows[0].n).toBe(1);
  });

  it('asks every time on an every-time kind, and one approval delivers one use', async () => {
    await owner().secrets!.put('Card', VALUE, [{ kind: 'mail.card', target: 'shop', rule: 'first-time' }]);
    const host = hostFor(mail);
    const approve = async (): Promise<void> => {
      const asked = await host.secrets!.use('Card', 'mail.card', 'shop');
      const actionId = (asked as { pending: string }).pending;
      expect(actionId).toEqual(expect.any(String));
      await decideApproval(pool, { actionId, decision: 'approved', by: 'owner', via: 'web', now });
      expect((await executeApproved(pool, { actionId, registry, ctx: facts(), worker: 'test', now })).ok).toBe(true);
    };
    await approve();
    expect(await host.secrets!.use('Card', 'mail.card', 'shop')).toHaveProperty('done', true);
    expect(await host.secrets!.use('Card', 'mail.card', 'shop')).toHaveProperty('pending');
    const { rows } = await pool.query(`select count(*)::int as n from core.actions where canonical_args->>'secret' = 'Card'`);
    expect(rows[0].n).toBe(2);
    expect(delivered.size).toBe(1);
  });

  it('refuses when the destination throws, without the value in the message', async () => {
    const leaky = manifest('leaky', [
      { ...destination('leaky.account', 'pre-approved'), deliver: (value) => { throw new Error(`bad login ${value}`); } },
    ]);
    registry.register(leaky);
    await hostFor(leaky, { agentId: 'owner' }).secrets!.put('L', VALUE, [{ kind: 'leaky.account', target: 1, rule: 'pre-approved' }]);
    const result = await hostFor(leaky).secrets!.use('L', 'leaky.account', 1);
    expect(result).toEqual({ refused: 'leaky.account could not take "L": bad login ‹secret:L›' });
    const { rows } = await pool.query(`select outcome, detail from core.secret_uses where plugin = 'leaky'`);
    expect(rows).toEqual([{ outcome: 'failed', detail: 'bad login ‹secret:L›' }]);
  });

  it("is absent for a plugin that did not declare secrets, and destinations need the declaration", () => {
    const plain: PluginManifest = { name: 'plain', version: '1.0.0', schema: 'plain', migrationsDir: '', tools: [] };
    expect(hostFor(plain).secrets).toBeUndefined();
    expect(() =>
      new ToolRegistry().register({ ...plain, name: 'plain2', destinations: [destination('plain2.x', 'pre-approved')] }),
    ).toThrow(/not uses: secrets/);
  });

  it('adopts a vault entry once, deleting the old one only after the new one reads back', async () => {
    const old = createMemoryVault({ seed: { EMAIL_A_EXAMPLE_TEST_0123abcd: VALUE } });
    const bindings = [{ kind: 'mail.account', target: 'acct-1', rule: 'pre-approved' as const }];
    const input = { from: 'EMAIL_A_EXAMPLE_TEST_0123abcd', name: 'EMAIL_A_EXAMPLE_TEST_0123abcd', bindings };

    expect(await adoptVaultEntry(pool, old, input)).toBe('adopted');
    const secret = (await findSecret(pool, input.name))!;
    expect(await old.get(ownerSecretVaultName(secret.id))).toBe(VALUE);
    expect(await old.get(input.from)).toBeNull();
    expect(await adoptVaultEntry(pool, old, input)).toBe('already');
    expect(await old.list()).toEqual([ownerSecretVaultName(secret.id)]);

    // The day-1 `.env` copy, when the vault holds none.
    expect(await adoptVaultEntry(pool, old, { ...input, from: 'GMAIL_APP_PASSWORD', name: 'GMAIL_APP_PASSWORD', fallback: 'from-env' })).toBe('adopted');
    expect(await adoptVaultEntry(pool, old, { ...input, from: 'NOTHING', name: 'NOTHING' })).toBe('nothing');

    // A vault that does not read back keeps the old entry.
    const liar: Vault = { ...createMemoryVault({ seed: { OLD: VALUE } }) };
    const inner = createMemoryVault({ seed: { OLD: VALUE } });
    Object.assign(liar, {
      get: async (name: string) => (name.startsWith('owner-secret:') ? 'something else' : inner.get(name)),
      set: inner.set,
      delete: inner.delete,
      list: inner.list,
    });
    await expect(adoptVaultEntry(pool, liar, { ...input, from: 'OLD', name: 'OLD' })).rejects.toThrow(/old entry was kept/);
    expect(await inner.get('OLD')).toBe(VALUE);
  });

  it('hands a core-internal caller the value through deliverInto, recorded like any use', async () => {
    // Core's own destinations (the http area, the gateway's provider accounts)
    // register under their own name and take the value through `deliverInto`.
    registerSecretDestination('core-internal', {
      kind: 'core-internal.thing',
      maxRule: 'pre-approved',
      checkTarget: (target, bound) => target === bound,
      describe: () => 'the thing',
      deliver: () => {
        throw new Error('the internal caller delivers through deliverInto');
      },
    });
    // The Settings page stores through the store directly; the host area's
    // `put` is the plugin's own narrower path.
    await putOwnerSecret(pool, vault, {
      name: 'Header key',
      value: VALUE,
      bindings: [{ kind: 'core-internal.thing', target: 'acct-1', rule: 'pre-approved' }],
    });
    const taken: Array<{ value: string; target: unknown; use: string }> = [];
    const result = await useOwnerSecret(
      {
        pool,
        vault,
        plugin: 'core-internal',
        buddi: owner(),
        now: () => now,
        deliverInto: (value, target, use) => {
          taken.push({ value, target, use });
        },
      },
      { name: 'Header key', kind: 'core-internal.thing', target: 'acct-1' },
    );
    expect(result).toEqual({ done: true, use: expect.any(String) });
    expect(taken).toEqual([{ value: VALUE, target: 'acct-1', use: (result as { use: string }).use }]);
    const { rows } = await pool.query(`select plugin, outcome from core.secret_uses`);
    expect(rows).toEqual([{ plugin: 'core-internal', outcome: 'delivered' }]);
    resetSecretDestinations();
  });

  it('a TOTP secret delivers the current code into a browser field only (acceptance 6)', async () => {
    // RFC 6238's own test seed and vector: T0, 30-second steps, six digits.
    const seedBase32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"
    const ownerHost = owner();
    await putOwnerSecret(pool, vault, {
      name: 'Second factor',
      value: seedBase32,
      totp: true,
      bindings: [{ kind: 'browser.field', target: 'https://example.test', rule: 'pre-approved' }],
    });
    // The `browser.field` destination belongs to the plugin that fills
    // browser fields; a `browser` manifest stands in as that plugin.
    const browser = manifest('browser', [
      {
        kind: 'browser.field',
        maxRule: 'pre-approved',
        checkTarget: (target, bound) => target === bound,
        describe: (target) => `the field on ${String(target)}`,
        deliver: (value, _target, { use }) => {
          delivered.set(use, value);
        },
      },
    ]);
    registry.register(browser);
    const at = new Date('1970-01-01T00:00:59Z');
    const result = await hostFor(browser, { now: () => at }).secrets!.use('Second factor', 'browser.field', 'https://example.test');
    expect(result).toEqual({ done: true, use: expect.any(String) });
    expect(delivered.get((result as { use: string }).use)).toBe('287082');
    // The seed is never what crosses, and every code generated is logged.
    const { rows } = await pool.query(`select detail from core.secret_uses where kind = 'browser.field'`);
    expect(rows[0].detail).toMatch(/code generated for the window ending 1970-01-01T00:01:00/);
    // Another kind is refused before any card or delivery.
    const elsewhere = await ownerHost.secrets!.use('Second factor', 'mail.account', 'acct-1');
    expect(elsewhere).toEqual({ refused: expect.stringMatching(/TOTP secret/) });
  });
});
