/**
 * `buddi vault set | get | delete | list | import-env`.
 *
 * The vault is the OS keychain (or, off macOS, a file encrypted with a key held
 * outside the database). ARCHITECTURE.md is blunt about why there is no table:
 * *«A secrets table would hand mail and model credentials to anyone with the
 * database file.»*
 *
 * Two rules shape every command here:
 *
 *  - **A secret value is never printed.** `get` answers "set" or "not set",
 *    which is the only question a terminal needs answered. Reading a secret
 *    back out is what the vault is for, and it is not a display feature.
 *  - **Input is hidden.** `set` reads from the terminal with echo off, so the
 *    value never lands in scrollback — and never in shell history either,
 *    because there is no way to pass it as an argument.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  KNOWN_SECRETS,
  VAULT_PLACEHOLDER_LINE,
  VaultLockedError,
  VaultUnavailableError,
  assertSecretName,
  createVault,
  isVaultPlaceholder,
  vaultSelection,
  type Vault,
} from '@buddi/core';
import type { VaultAction } from './args.js';
import { applyEnvEdits, parseEnv } from './env-file.js';
import { ENV_FILE } from './paths.js';

export interface VaultDeps {
  vault?: Vault | undefined;
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  /** Reads one secret with the terminal's echo off. Injected in tests. */
  promptSecret?: (label: string) => Promise<string>;
  /** Asks a yes/no question. Injected in tests. */
  confirm?: (question: string) => Promise<boolean>;
  out?: (line: string) => void;
}

/* ------------------------------------------------------------------ *
 * Terminal input
 * ------------------------------------------------------------------ */

/**
 * Read a line with echo off.
 *
 * `readline` has no hidden mode, so the output stream is muted while the answer
 * is typed. On a non-TTY (a pipe, a CI run) there is nothing to mute and
 * nothing to hide: the line is read plainly, which is the honest behaviour for
 * `echo "$TOKEN" | buddi vault set NAME`.
 */
export async function promptHidden(label: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const isTty = Boolean((input as NodeJS.ReadStream).isTTY);

  const rl = createInterface({ input, output, terminal: isTty });
  try {
    if (!isTty) {
      return await new Promise<string>((resolve) => rl.question('', resolve));
    }
    output.write(label);
    let muted = false;
    const write = output.write.bind(output);
    // While muted, everything the terminal would echo is swallowed — including
    // the characters readline writes back as they are typed.
    (output as unknown as { write: (chunk: any, ...rest: any[]) => boolean }).write = (
      chunk: any,
      ...rest: any[]
    ): boolean => (muted ? true : write(chunk, ...rest));
    muted = true;
    try {
      const answer = await new Promise<string>((resolve) => rl.question('', resolve));
      muted = false;
      write('\n');
      return answer;
    } finally {
      muted = false;
      (output as unknown as { write: unknown }).write = write;
    }
  } finally {
    rl.close();
  }
}

export async function confirmTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

export async function runVault(
  action: VaultAction,
  name: string | undefined,
  deps: VaultDeps = {},
): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const env = deps.env ?? process.env;
  const selection = vaultSelection({ env });
  const vault = deps.vault ?? createVault({ env });

  if (!vault) {
    out(
      `No vault on this machine (BUDDI_VAULT=${selection}). Secrets come from .env, which is the day-1 fallback.`,
    );
    return 1;
  }

  try {
    switch (action) {
      case 'set':
        return await setSecret(vault, requireName(name), deps, out);
      case 'get':
        return await getSecret(vault, requireName(name), out);
      case 'delete':
        return await deleteSecret(vault, requireName(name), out);
      case 'list':
        return await listSecrets(vault, out);
      case 'import-env':
        return await importEnv(vault, deps, out);
    }
  } catch (err) {
    if (err instanceof VaultLockedError) {
      out(`The vault is locked: ${err.message}`);
      return 1;
    }
    if (err instanceof VaultUnavailableError) {
      out(`No usable vault: ${err.message}`);
      return 1;
    }
    out(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function requireName(name: string | undefined): string {
  if (!name) throw new Error('this command needs a secret name, e.g. TELEGRAM_BOT_TOKEN');
  return assertSecretName(name);
}

async function setSecret(
  vault: Vault,
  name: string,
  deps: VaultDeps,
  out: (line: string) => void,
): Promise<number> {
  const prompt = deps.promptSecret ?? promptHidden;
  const value = (await prompt(`Value for ${name} (input hidden): `)).trim();
  if (value === '') {
    out('Nothing entered; nothing stored.');
    return 1;
  }
  await vault.set(name, value);
  // The value is not echoed back, not even masked: the owner just typed it.
  out(`Stored ${name} in the ${vault.kind} vault.`);
  return 0;
}

async function getSecret(
  vault: Vault,
  name: string,
  out: (line: string) => void,
): Promise<number> {
  const value = await vault.get(name);
  out(`${name}: ${value === null || value.trim() === '' ? 'not set' : 'set'}`);
  return value === null ? 1 : 0;
}

async function deleteSecret(
  vault: Vault,
  name: string,
  out: (line: string) => void,
): Promise<number> {
  const removed = await vault.delete(name);
  out(removed ? `Removed ${name} from the ${vault.kind} vault.` : `${name} was not in the vault.`);
  return removed ? 0 : 1;
}

async function listSecrets(vault: Vault, out: (line: string) => void): Promise<number> {
  const names = await vault.list();
  if (names.length === 0) {
    out(`The ${vault.kind} vault holds no buddi secrets yet.`);
    return 0;
  }
  out(`Secrets in the ${vault.kind} vault:`);
  for (const name of names) out(`  ${name}`);
  return 0;
}

/* ------------------------------------------------------------------ *
 * import-env
 * ------------------------------------------------------------------ */

/** What `import-env` would do, computed before anything is touched. */
export function plannedImports(
  envText: string,
  known: readonly string[] = KNOWN_SECRETS,
): string[] {
  const parsed = parseEnv(envText);
  return known.filter((name) => {
    const value = (parsed[name] ?? '').trim();
    return value !== '' && !isVaultPlaceholder(value);
  });
}

/**
 * Move every known secret out of `.env` and into the vault.
 *
 * A *move*, not a copy: the line stays, so the file still documents which
 * secrets this installation uses, but its value becomes `"<vault>"` — a marker
 * `resolveSecret` treats as absent. The quotes are load-bearing: unquoted,
 * `<vault>` is a redirection and `. ./.env` dies with a parse error.
 * A half-finished import is safe by
 * construction: each secret is written to the vault before `.env` is rewritten,
 * and a secret already in the vault is simply overwritten with the same value.
 */
async function importEnv(
  vault: Vault,
  deps: VaultDeps,
  out: (line: string) => void,
): Promise<number> {
  const file = deps.envFile ?? ENV_FILE;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    out(`No .env at ${file} — nothing to import.`);
    return 1;
  }

  const names = plannedImports(text);
  if (names.length === 0) {
    out('No secrets left in .env — everything known is already in the vault.');
    return 0;
  }

  out(`This will move ${names.length} secret${names.length === 1 ? '' : 's'} into the ${vault.kind} vault:`);
  for (const name of names) out(`  ${name}`);
  out(`and rewrite each line in ${file} to NAME=${VAULT_PLACEHOLDER_LINE} (quoted, so \`. ./.env\` still works).`);

  const confirm = deps.confirm ?? confirmTty;
  if (!(await confirm('Move them now?'))) {
    out('Nothing was changed.');
    return 1;
  }

  const parsed = parseEnv(text);
  const moved: string[] = [];
  for (const name of names) {
    const value = (parsed[name] ?? '').trim();
    if (value === '') continue;
    await vault.set(name, value);
    moved.push(name);
  }

  const rewritten = applyEnvEdits(
    text,
    moved.map((name) => ({ key: name, value: VAULT_PLACEHOLDER_LINE })),
  );
  await writeFile(file, rewritten, { mode: 0o600 });

  out(`Moved ${moved.length} secret${moved.length === 1 ? '' : 's'} into the vault.`);
  out('Restart buddi (or `buddi service restart`) so the running process picks them up.');
  return 0;
}
