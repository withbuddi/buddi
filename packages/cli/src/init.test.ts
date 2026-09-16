/**
 * `buddi init` — the one command every stranger runs exactly once.
 *
 * Until now only the *planner* was covered, which is the half that decides what
 * to do. This is the other half: the steps that touch a machine. They are
 * tested at the seams the wizard already exposes — `ensureVaultKey`,
 * `setUpDatabasePassword`, `setUpPrivateConfig`, `ensureService`, `pairHere` —
 * rather than by driving `runInit`, which spawns `pnpm` and docker and would be
 * a test of this laptop rather than of the wizard.
 *
 * Four situations are what actually break a stranger, and each has its own
 * block below: a fresh machine with nothing set, a second run on a finished
 * one, a half-finished installation, and a machine with no OS keychain.
 *
 * **Nothing here touches the owner's installation.** Every path is a
 * `mkdtemp`: `HOME`, the vault file, the `.env`, the private directory. In
 * particular `setUpPrivateConfig` defaults to `<repo>/private`, which is the
 * owner's real agents directory, so every call to it in this file pins
 * `BUDDI_AGENTS_DIR` or answers the prompt with a temporary path. No test here
 * opens a keychain, a database or a docker socket.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileVault, createMemoryVault, DB_PASSWORD_VAR } from '@buddi/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectedTimezone,
  ensureService,
  ensureVaultKey,
  hasPrivateAgents,
  offerFirstRun,
  pairHere,
  PRIVATE_README,
  secureEnvFile,
  setUpDatabasePassword,
  setUpPrivateConfig,
  validTimezone,
} from './init.js';

/* ------------------------------------------------------------------ *
 * A throwaway machine
 * ------------------------------------------------------------------ */

const made: string[] = [];

function tmpDir(what: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `buddi-init-${what}-`));
  made.push(dir);
  return dir;
}

/** A `.env` nobody else can see, with whatever the case under test needs in it. */
function tmpEnvFile(contents = ''): string {
  const file = path.join(tmpDir('env'), '.env');
  writeFileSync(file, contents);
  return file;
}

/** Lines a step printed, joined — what the owner would have read. */
function recorder(): { log: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), text: () => lines.join('\n') };
}

/** `confirm`, with a fixed answer. */
const always = (answer: boolean) => async () => answer;

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ *
 * 1. A fresh machine with no OS keychain — the Linux path
 * ------------------------------------------------------------------ */

describe('ensureVaultKey', () => {
  /**
   * The regression this whole block exists for. On anything but macOS the vault
   * is a file, the file needs `BUDDI_VAULT_KEY`, and until this step existed a
   * clone with no key answered its owner's first command with a
   * `VaultLockedError` stack trace and a variable name they had no way to
   * produce a value for.
   */
  it('generates a key on a machine with no keychain, and writes it to .env', async () => {
    const home = tmpDir('home');
    const envFile = tmpEnvFile('# BUDDI_VAULT_KEY=\n');
    const env: NodeJS.ProcessEnv = { BUDDI_VAULT: 'file', BUDDI_HOME: home };
    const out = recorder();

    const result = await ensureVaultKey({
      envFile,
      env,
      confirm: always(true),
      interactive: true,
      assumeYes: false,
      log: out.log,
      generate: () => 'a-test-key',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.generated).toBe(true);
    // In the file, and in this process, so the very next step can use the vault.
    expect(readFileSync(envFile, 'utf8')).toContain('BUDDI_VAULT_KEY=a-test-key');
    expect(env.BUDDI_VAULT_KEY).toBe('a-test-key');
    // And the sentence a stranger has to read exactly once.
    expect(out.text()).toContain('only copy');
    expect(out.text()).toContain('never contains it');
  });

  it('uses the commented line .env.example ships rather than appending a second one', async () => {
    const envFile = tmpEnvFile('# BUDDI_VAULT_KEY=       # a comment\nBUDDI_TZ=Europe/Paris\n');
    await ensureVaultKey({
      envFile,
      env: { BUDDI_VAULT: 'file', BUDDI_HOME: tmpDir('home') },
      confirm: always(true),
      interactive: true,
      assumeYes: false,
      log: () => {},
      generate: () => 'k',
    });
    const text = readFileSync(envFile, 'utf8');
    expect(text.match(/BUDDI_VAULT_KEY/g)).toHaveLength(1);
    expect(text).toContain('BUDDI_TZ=Europe/Paris');
  });

  it('does nothing at all when the machine has a keychain', async () => {
    const envFile = tmpEnvFile('');
    const result = await ensureVaultKey({
      envFile,
      env: { BUDDI_VAULT: 'keychain' },
      confirm: always(true),
      interactive: true,
      assumeYes: false,
      log: () => {},
    });
    expect(result.ok && result.generated).toBe(false);
    expect(readFileSync(envFile, 'utf8')).toBe('');
  });

  it('does nothing when the file vault already has its key', async () => {
    const envFile = tmpEnvFile('BUDDI_VAULT_KEY=mine\n');
    const result = await ensureVaultKey({
      envFile,
      env: { BUDDI_VAULT: 'file', BUDDI_VAULT_KEY: 'mine', BUDDI_HOME: tmpDir('home') },
      confirm: always(true),
      interactive: true,
      assumeYes: false,
      log: () => {},
      generate: () => 'must-not-be-used',
    });
    expect(result.ok && result.generated).toBe(false);
    expect(readFileSync(envFile, 'utf8')).toBe('BUDDI_VAULT_KEY=mine\n');
  });

  /**
   * A key is a thing you can lose, so it is never minted behind someone's back.
   * With nobody to ask and no `--yes`, the answer is a refusal that names the
   * two ways forward — and writes nothing.
   */
  it('refuses rather than generating when it cannot ask and was not told --yes', async () => {
    const envFile = tmpEnvFile('');
    const result = await ensureVaultKey({
      envFile,
      env: { BUDDI_VAULT: 'file', BUDDI_HOME: tmpDir('home') },
      confirm: always(true),
      interactive: false,
      assumeYes: false,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.advice).toContain('buddi init --yes');
    expect(!result.ok && result.advice).toContain('openssl rand');
    expect(readFileSync(envFile, 'utf8')).toBe('');
  });

  it('generates without asking under --yes, so a scripted install works', async () => {
    const envFile = tmpEnvFile('');
    const result = await ensureVaultKey({
      envFile,
      env: { BUDDI_VAULT: 'file', BUDDI_HOME: tmpDir('home') },
      confirm: async () => {
        throw new Error('--yes must not ask anything');
      },
      interactive: false,
      assumeYes: true,
      log: () => {},
      generate: () => 'scripted',
    });
    expect(result.ok && result.generated).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain('BUDDI_VAULT_KEY=scripted');
  });

  it('writes nothing when the owner says no to the question', async () => {
    const envFile = tmpEnvFile('');
    const result = await ensureVaultKey({
      envFile,
      env: { BUDDI_VAULT: 'file', BUDDI_HOME: tmpDir('home') },
      confirm: always(false),
      interactive: true,
      assumeYes: false,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(readFileSync(envFile, 'utf8')).toBe('');
  });

  /** The generated key must survive `set -a; . ./.env` and a `dotenv` read. */
  /**
   * `.env` is copied from `.env.example`, which is a 644 file in git, and
   * `writeFileSync`'s `mode` is ignored for a file that already exists — so the
   * key landed in a world-readable file while every message said 600. The
   * permission is now set explicitly on every write.
   */
  it('leaves .env readable by nobody but its owner', async () => {
    const envFile = tmpEnvFile('');
    chmodSync(envFile, 0o644);
    await ensureVaultKey({
      envFile,
      env: { BUDDI_VAULT: 'file', BUDDI_HOME: tmpDir('home') },
      confirm: always(true),
      interactive: true,
      assumeYes: false,
      log: () => {},
    });
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it('generates a key with no character a shell would interpret', async () => {
    const envFile = tmpEnvFile('');
    await ensureVaultKey({
      envFile,
      env: { BUDDI_VAULT: 'file', BUDDI_HOME: tmpDir('home') },
      confirm: always(true),
      interactive: true,
      assumeYes: false,
      log: () => {},
    });
    const value = /^BUDDI_VAULT_KEY=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1];
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  /**
   * And the whole point: the generated key actually opens the vault the next
   * step is about to write to. Nothing is asserted about ciphertext — the
   * assertion is that a secret goes in and comes back.
   */
  it('produces a key the file vault can be used with immediately', async () => {
    const home = tmpDir('home');
    const env: NodeJS.ProcessEnv = { BUDDI_VAULT: 'file', BUDDI_HOME: home };
    await ensureVaultKey({
      envFile: tmpEnvFile(''),
      env,
      confirm: always(true),
      interactive: true,
      assumeYes: false,
      log: () => {},
    });
    const vault = createFileVault({ env });
    await vault.set('TELEGRAM_BOT_TOKEN', 'not-a-real-token');
    expect(await vault.get('TELEGRAM_BOT_TOKEN')).toBe('not-a-real-token');
    expect(existsSync(path.join(home, 'vault.json'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The database password
 * ------------------------------------------------------------------ */

describe('setUpDatabasePassword', () => {
  it('generates one on a fresh machine and keeps it out of every file', async () => {
    const vault = createMemoryVault();
    const out = recorder();

    const url = await setUpDatabasePassword(
      vault,
      { BUDDI_DB_PORT: '55433' },
      { log: out.log, envFile: tmpEnvFile('') },
    );

    const stored = await vault.get(DB_PASSWORD_VAR);
    expect(stored).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(url).toContain('@127.0.0.1:55433/buddi');
    expect(url).toContain(encodeURIComponent(stored as string));
    expect(out.text()).toContain('generated');
    // The shape, never the value.
    expect(out.text()).not.toContain(stored as string);
  });

  it('is a no-op on a second run — the vault already holds one', async () => {
    const vault = createMemoryVault();
    const envFile = tmpEnvFile('');
    const first = await setUpDatabasePassword(vault, {}, { log: () => {}, envFile });
    const out = recorder();
    const second = await setUpDatabasePassword(vault, {}, { log: out.log, envFile });
    expect(second).toBe(first);
    expect(out.text()).toContain('already in the vault');
  });

  it('leaves an owner who runs their own Postgres completely alone', async () => {
    const vault = createMemoryVault();
    const url = 'postgres://me:mine@db.internal:5432/buddi';
    const out = recorder();

    const resolved = await setUpDatabasePassword(
      vault,
      { DATABASE_URL: url },
      // The question is asked of the *file*, not of this environment, because
      // by the time the wizard runs every subcommand has already assembled a
      // URL into `process.env`.
      { log: out.log, envFile: tmpEnvFile(`DATABASE_URL=${url}\n`) },
    );

    expect(resolved).toBe(url);
    expect(await vault.list()).toEqual([]);
    expect(out.text()).toContain('will not touch it');
  });

  /**
   * The finding, one layer up: a locked vault reaching this function is a
   * sentence and an `undefined` URL, never an exception. The wizard's own
   * `ensureVaultKey` runs first, so in practice this is the "the key does not
   * open the vault that is already here" case.
   */
  it('reports a locked vault instead of throwing', async () => {
    const env: NodeJS.ProcessEnv = { BUDDI_VAULT: 'file', BUDDI_HOME: tmpDir('home') };
    const vault = createFileVault({ env });
    const out = recorder();

    const url = await setUpDatabasePassword(vault, env as Record<string, string>, {
      log: out.log,
      envFile: tmpEnvFile(''),
    });

    expect(url).toBeUndefined();
    expect(out.text()).toContain('not stored');
    expect(out.text()).toContain('BUDDI_VAULT_KEY');
  });
});

/* ------------------------------------------------------------------ *
 * 3. The private directory — fresh, half-done, and already finished
 * ------------------------------------------------------------------ */

describe('setUpPrivateConfig', () => {
  it('creates the directory, explains it, and seeds the example agent', async () => {
    const root = path.join(tmpDir('private'), 'mine');
    const out = recorder();
    const remembered: Record<string, string> = {};

    const resolved = await setUpPrivateConfig(
      async () => root,
      {},
      (key, value) => {
        remembered[key] = value;
      },
      // `defaultRoot` is the seam that makes this safe to run at all: the real
      // default is `<repo>/private`, which on a developer's machine is the
      // owner's own agents directory.
      { log: out.log, interactive: true, defaultRoot: path.join(tmpDir('default'), 'private') },
    );

    expect(resolved).toBe(root);
    expect(existsSync(path.join(root, 'agents'))).toBe(true);
    expect(existsSync(path.join(root, 'skills'))).toBe(true);
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(PRIVATE_README);
    // A non-default location is written back, or the next boot would not find it.
    expect(remembered.BUDDI_AGENTS_DIR).toBe(path.join(root, 'agents'));
    // The first question after "where does my configuration live" is "what does
    // one look like", so an empty directory gets the shipped example copied in.
    expect(existsSync(path.join(root, 'agents', 'concierge', 'agent.md'))).toBe(true);
  });

  it('leaves an agent that is already there exactly as it was', async () => {
    const root = tmpDir('private');
    const agent = path.join(root, 'agents', 'ledger');
    mkdirSync(agent, { recursive: true });
    writeFileSync(path.join(agent, 'agent.md'), 'mine, do not touch\n');

    await setUpPrivateConfig(
      async () => {
        throw new Error('a pinned directory must not be asked about');
      },
      { BUDDI_AGENTS_DIR: path.join(root, 'agents') },
      () => {
        throw new Error('a pinned directory must not be written back');
      },
      { log: () => {}, interactive: true },
    );

    expect(readFileSync(path.join(agent, 'agent.md'), 'utf8')).toBe('mine, do not touch\n');
    // The example is not copied over a directory that already has something in it.
    expect(existsSync(path.join(root, 'agents', 'concierge'))).toBe(false);
  });

  /** A half-finished installation: the folder exists, the README does not. */
  it('completes a partial directory without overwriting what is there', async () => {
    const root = tmpDir('private');
    mkdirSync(path.join(root, 'agents', 'ledger'), { recursive: true });
    writeFileSync(path.join(root, 'agents', 'ledger', 'agent.md'), 'mine\n');

    await setUpPrivateConfig(
      async () => '',
      { BUDDI_AGENTS_DIR: path.join(root, 'agents') },
      () => {},
      { log: () => {}, interactive: true },
    );

    expect(existsSync(path.join(root, 'skills'))).toBe(true);
    expect(existsSync(path.join(root, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(root, 'agents', 'ledger', 'agent.md'), 'utf8')).toBe('mine\n');
  });

  it('keeps an existing README rather than rewriting the owner\'s notes', async () => {
    const root = tmpDir('private');
    mkdirSync(path.join(root, 'agents'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), 'my own notes\n');

    await setUpPrivateConfig(
      async () => '',
      { BUDDI_AGENTS_DIR: path.join(root, 'agents') },
      () => {},
      { log: () => {}, interactive: true },
    );

    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('my own notes\n');
  });

  it('takes the pinned directory as the answer and never asks', async () => {
    const root = tmpDir('private');
    const out = recorder();
    await setUpPrivateConfig(
      async () => {
        throw new Error('must not ask');
      },
      { BUDDI_AGENTS_DIR: path.join(root, 'agents') },
      () => {
        throw new Error('must not write back what was already pinned');
      },
      { log: out.log, interactive: true },
    );
    expect(out.text()).toContain('BUDDI_AGENTS_DIR');
    expect(existsSync(path.join(root, 'agents'))).toBe(true);
  });
});

describe('hasPrivateAgents', () => {
  it('is false for a directory that does not exist', () => {
    expect(hasPrivateAgents({ BUDDI_AGENTS_DIR: path.join(tmpDir('none'), 'nope') })).toBe(false);
  });

  it('is false for an empty one, and for one holding only dotfiles', () => {
    const dir = tmpDir('agents');
    expect(hasPrivateAgents({ BUDDI_AGENTS_DIR: dir })).toBe(false);
    writeFileSync(path.join(dir, '.DS_Store'), '');
    expect(hasPrivateAgents({ BUDDI_AGENTS_DIR: dir })).toBe(false);
  });

  it('is true once an agent is in it', () => {
    const dir = tmpDir('agents');
    mkdirSync(path.join(dir, 'ledger'));
    expect(hasPrivateAgents({ BUDDI_AGENTS_DIR: dir })).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 4. The steps that can fail without failing the installation
 * ------------------------------------------------------------------ */

describe('ensureService', () => {
  it('says nothing to install when a service is already there', async () => {
    const install = vi.fn();
    vi.spyOn(await import('./service/index.js'), 'createServiceManager').mockReturnValue({
      status: async () => ({ installed: true, running: true, detail: 'running (pid 1)' }),
      install,
    } as never);

    expect(await ensureService(always(false))).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });

  it('is a declined offer, not a failure, when the owner says no', async () => {
    vi.spyOn(await import('./service/index.js'), 'createServiceManager').mockReturnValue({
      status: async () => ({ installed: false, running: false, detail: 'absent' }),
      install: async () => {
        throw new Error('must not install after a no');
      },
    } as never);

    expect(await ensureService(always(false))).toBe(false);
  });

  /**
   * A launchd that refuses is a line to read. Everything else `init` did still
   * stands, so this returns `false` rather than unwinding the wizard.
   */
  it('survives a service manager that throws', async () => {
    vi.spyOn(await import('./service/index.js'), 'createServiceManager').mockReturnValue({
      status: async () => ({ installed: false, running: false, detail: 'absent' }),
      install: async () => {
        throw new Error('launchctl: Operation not permitted');
      },
    } as never);

    expect(await ensureService(always(true))).toBe(false);
  });
});

describe('pairHere', () => {
  it('does nothing without a database to mint a code in', async () => {
    expect(
      await pairHere(async () => {
        throw new Error('must not ask before checking for a database');
      }, {}),
    ).toBe(false);
  });

  it('is skippable', async () => {
    expect(await pairHere(always(false), { DATABASE_URL: 'postgres://x@127.0.0.1:1/x' })).toBe(
      false,
    );
  });

  /**
   * A pairing code has a ten-minute life and is claimed by the *surface*, not
   * by this process. With nothing listening, printing one would hand the owner
   * a QR code that can never work.
   */
  it('refuses to print a code when nothing is listening for it', async () => {
    const onNeedsService = vi.fn(async () => false);
    expect(
      await pairHere(always(true), { DATABASE_URL: 'postgres://x@127.0.0.1:1/x' }, {
        onNeedsService,
      }),
    ).toBe(false);
    expect(onNeedsService).toHaveBeenCalled();
  });
});

describe('offerFirstRun', () => {
  it('offers nothing on an installation that has already had its first run', async () => {
    expect(await offerFirstRun(always(true), { key: 'first-run', action: 'done' } as never)).toBe(
      false,
    );
    expect(await offerFirstRun(always(true), { key: 'first-run', action: 'skipped' } as never)).toBe(
      false,
    );
  });

  it('points a paired owner at their phone rather than starting a chat here', async () => {
    expect(await offerFirstRun(always(true), { key: 'first-run', action: 'run' } as never)).toBe(
      false,
    );
  });

  it('offers the conversation here when there is no other surface', async () => {
    expect(await offerFirstRun(always(true), { key: 'first-run', action: 'ask' } as never)).toBe(
      true,
    );
    expect(await offerFirstRun(always(false), { key: 'first-run', action: 'ask' } as never)).toBe(
      false,
    );
  });
});

describe('secureEnvFile', () => {
  it('is not fatal when the permission cannot be set', () => {
    const warned: string[] = [];
    secureEnvFile(path.join(tmpDir('gone'), 'nope', '.env'), (l) => warned.push(l));
    expect(warned.join('\n')).toContain('mode 600');
  });
});

describe('timezone', () => {
  it('accepts an IANA zone and rejects anything else', () => {
    expect(validTimezone('Europe/Paris')).toBe(true);
    expect(validTimezone('America/New_York')).toBe(true);
    expect(validTimezone('Paris')).toBe(false);
    expect(validTimezone('')).toBe(false);
  });

  it('detects one that it would itself accept', () => {
    expect(validTimezone(detectedTimezone())).toBe(true);
  });
});
