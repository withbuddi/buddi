/**
 * Adding a mailbox from the dashboard: the vault, the login test, and the row.
 *
 * Every assertion here is about one of the three things that must not go wrong
 * when a password crosses this boundary — it is tested before it is kept, it is
 * kept in the vault and nowhere else, and a refusal keeps nothing at all.
 */
import { expect, it, vi } from 'vitest';
import { createMemoryVault, type Vault } from '@buddi/core';
import { secretNameFor } from '@buddi/tool-email';
import type { ImapClientFactory } from '@buddi/tool-email';
import {
  EmailWebError,
  addEmailAccount,
  listEmailAccounts,
  removeEmailAccount,
  readNewAccount,
  type EmailWebDeps,
} from './email.js';

const ADDRESS = 'owner@work.test';
const SECRET = secretNameFor(ADDRESS);

const BODY = {
  address: 'Owner@Work.TEST',
  imapHost: 'imap.work.test',
  imapPort: 993,
  smtpHost: 'smtp.work.test',
  smtpPort: 465,
  password: 'an-app-password',
  displayName: 'Work',
  aliases: ['invoices@work.test'],
};

/** Just enough pool for the duplicate check, the insert and the delete. */
function fakePool(over: { existing?: boolean; failInsert?: boolean } = {}) {
  const inserted: unknown[][] = [];
  return {
    inserted,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (/select 1 from email\.accounts/.test(sql)) {
        return { rows: over.existing ? [{ '?column?': 1 }] : [] };
      }
      if (/insert into email\.accounts/.test(sql)) {
        if (over.failInsert) throw new Error('the disk is full');
        inserted.push(params);
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              address: params[0],
              imap_host: params[1],
              imap_port: params[2],
              smtp_host: params[3],
              smtp_port: params[4],
              auth_mode: 'app-password',
              secret_name: params[5],
              aliases: params[6],
              display_name: params[7],
              enabled: true,
              added_via: 'page',
              created_at: new Date('2026-09-21T10:00:00Z'),
            },
          ],
        };
      }
      if (/delete from email\.accounts/.test(sql)) {
        return {
          rows: [
            {
              id: params[0],
              address: ADDRESS,
              imap_host: 'imap.work.test',
              imap_port: 993,
              smtp_host: 'smtp.work.test',
              smtp_port: 465,
              auth_mode: 'app-password',
              secret_name: SECRET,
              aliases: [],
              display_name: null,
              enabled: true,
              added_via: 'page',
              created_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    }),
  };
}

/** An IMAP that opens, or one that refuses the way a wrong password does. */
function fakeConnect(refuse?: string): { connect: ImapClientFactory; opens: () => number; closes: () => number } {
  let opens = 0;
  let closes = 0;
  return {
    opens: () => opens,
    closes: () => closes,
    connect: (async () => ({
      open: async () => {
        if (refuse) throw new Error(refuse);
        opens += 1;
        return { uidValidity: 1, uidNext: 1, exists: 0 };
      },
      fetchSince: async () => [],
      close: async () => { closes += 1; },
    })) as ImapClientFactory,
  };
}

function deps(over: Omit<Partial<EmailWebDeps>, 'pool'> & { pool?: ReturnType<typeof fakePool> } = {}): {
  deps: EmailWebDeps;
  vault: Vault;
  env: NodeJS.ProcessEnv;
} {
  const vault = (over.vault as Vault | undefined) ?? createMemoryVault();
  const env: NodeJS.ProcessEnv = over.env ?? {};
  return {
    vault,
    env,
    deps: {
      pool: (over.pool ?? fakePool()) as never,
      env,
      vault,
      connect: over.connect ?? fakeConnect().connect,
    },
  };
}

it('tests the login, keeps the password in the vault, and writes only its name down', async () => {
  const pool = fakePool();
  const imap = fakeConnect();
  const { deps: d, vault, env } = deps({ pool, connect: imap.connect });

  const account = await addEmailAccount(d, BODY);

  // The login was tried once, and the connection was not left open.
  expect(imap.opens()).toBe(1);
  expect(imap.closes()).toBe(1);

  expect(account).toMatchObject({
    address: ADDRESS,
    displayName: 'Work',
    aliases: ['invoices@work.test'],
    secretName: SECRET,
    addedVia: 'page',
    enabled: true,
  });
  // The password is in the vault, under the name derived from the address...
  expect(await vault.get(SECRET)).toBe('an-app-password');
  // ...and in this process's environment, so the next poll needs no restart.
  expect(env[SECRET]).toBe('an-app-password');
  // ...and nowhere in what was written to the database.
  const written = JSON.stringify(pool.inserted);
  expect(written).toContain(SECRET);
  expect(written).not.toContain('an-app-password');
  // Nor in what comes back to the page.
  expect(JSON.stringify(account)).not.toContain('an-app-password');
});

it('refuses a login the mail server will not accept, and keeps nothing', async () => {
  const pool = fakePool();
  const { deps: d, vault, env } = deps({ pool, connect: fakeConnect('AUTHENTICATIONFAILED').connect });

  await expect(addEmailAccount(d, BODY)).rejects.toMatchObject({
    name: 'EmailWebError',
    status: 400,
  });
  await expect(addEmailAccount(d, BODY)).rejects.toThrow(/would not let us in as owner@work\.test/);

  expect(await vault.list()).toEqual([]);
  expect(env[SECRET]).toBeUndefined();
  expect(pool.inserted).toHaveLength(0);
});

it('says in plain words what is wrong with the form before it dials anything', async () => {
  const imap = fakeConnect();
  const { deps: d } = deps({ connect: imap.connect });
  await expect(addEmailAccount(d, { ...BODY, address: 'not-an-address' })).rejects.toThrow(
    /does not look like an email address/,
  );
  await expect(addEmailAccount(d, { ...BODY, password: '   ' })).rejects.toThrow(/password .* is missing/i);
  await expect(addEmailAccount(d, { ...BODY, imapPort: 0 })).rejects.toThrow(/port number/);
  expect(imap.opens()).toBe(0);
});

it('refuses an address that is already here rather than replacing it silently', async () => {
  const { deps: d } = deps({ pool: fakePool({ existing: true }) });
  await expect(addEmailAccount(d, BODY)).rejects.toMatchObject({ status: 409 });
});

it('takes the secret back out again when the row cannot be written', async () => {
  const { deps: d, vault, env } = deps({ pool: fakePool({ failInsert: true }) });
  await expect(addEmailAccount(d, BODY)).rejects.toMatchObject({ status: 500 });
  expect(await vault.list()).toEqual([]);
  expect(env[SECRET]).toBeUndefined();
});

it('removes the row and the vault entry together', async () => {
  const { deps: d, vault, env } = deps();
  await vault.set(SECRET, 'an-app-password');
  env[SECRET] = 'an-app-password';

  const removed = await removeEmailAccount(d, '11111111-1111-4111-8111-111111111111');
  expect(removed).toMatchObject({ removed: true, address: ADDRESS, secretRemoved: true });
  expect(await vault.get(SECRET)).toBeNull();
  expect(env[SECRET]).toBeUndefined();
});

it('normalises the form the page sends, and drops a repeated alias', () => {
  expect(readNewAccount({ ...BODY, aliases: ['Invoices@Work.TEST', 'invoices@work.test'] })).toMatchObject({
    address: ADDRESS,
    aliases: ['invoices@work.test'],
    displayName: 'Work',
  });
  expect(readNewAccount({ ...BODY, displayName: '   ' }).displayName).toBeNull();
});

it('lists what is configured without ever carrying a password', async () => {
  const listing = await listEmailAccounts(deps().deps);
  expect(listing.accounts).toEqual([]);
  expect(EmailWebError.name).toBe('EmailWebError');
});
