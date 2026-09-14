/**
 * A file-backed vault for machines with no keychain (CI, Linux, tests).
 *
 * The file holds AES-256-GCM ciphertext; the key is derived with scrypt from
 * `BUDDI_VAULT_KEY`, which is held *outside* the file and outside the database
 * — that is the whole point (ARCHITECTURE.md: "encrypted with keys held outside
 * the DB"). No key means locked, not readable-anyway.
 *
 * Each secret is sealed on its own, so reading one never decrypts the rest and
 * a corrupted entry cannot take the vault down with it.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertSecretName,
  assertSecretValue,
  VaultLockedError,
  VaultUnavailableError,
  type Vault,
} from './types.js';

/** Where the vault file lives unless `BUDDI_VAULT_FILE` says otherwise. */
export function defaultVaultFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.BUDDI_VAULT_FILE ?? '').trim();
  if (explicit !== '') return explicit;
  return path.join(env.BUDDI_HOME?.trim() || path.join(os.homedir(), '.buddi'), 'vault.json');
}

type Sealed = { iv: string; tag: string; ct: string };
type VaultFile = { version: 1; salt: string; entries: Record<string, Sealed> };

export interface FileVaultOptions {
  file?: string;
  env?: NodeJS.ProcessEnv;
}

function emptyFile(): VaultFile {
  return { version: 1, salt: randomBytes(16).toString('base64'), entries: {} };
}

function read(file: string): VaultFile {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    throw new VaultUnavailableError(`cannot read the vault file at ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VaultUnavailableError(`the vault file at ${file} is not valid JSON`);
  }
  const value = parsed as Partial<VaultFile>;
  if (value?.version !== 1 || typeof value.salt !== 'string' || typeof value.entries !== 'object') {
    throw new VaultUnavailableError(`the vault file at ${file} is not a buddi vault`);
  }
  return { version: 1, salt: value.salt, entries: (value.entries ?? {}) as Record<string, Sealed> };
}

function write(file: string, data: VaultFile): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    // Written beside the target and renamed, so a crash never leaves a
    // half-written vault where a whole one used to be.
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    throw new VaultUnavailableError(`cannot write the vault file at ${file}`);
  }
}

function keyFor(env: NodeJS.ProcessEnv, salt: string): Buffer {
  const secret = (env.BUDDI_VAULT_KEY ?? '').trim();
  if (secret === '') {
    throw new VaultLockedError(
      'the file vault is locked: BUDDI_VAULT_KEY is not set (it is the key, and it is never stored with the vault)',
    );
  }
  return scryptSync(secret, Buffer.from(salt, 'base64'), 32);
}

function seal(key: Buffer, name: string, value: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // The name is authenticated too: an entry moved to another key's slot fails
  // to open rather than answering with the wrong secret.
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

function open(key: Buffer, name: string, sealed: Sealed): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, 'base64')),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } catch {
    // Wrong key or tampered bytes — indistinguishable on purpose, and the
    // message says nothing about the value.
    throw new VaultLockedError(
      `cannot decrypt ${name}: BUDDI_VAULT_KEY does not open this vault`,
    );
  }
}

export function createFileVault(opts: FileVaultOptions = {}): Vault {
  const env = opts.env ?? process.env;
  const file = opts.file ?? defaultVaultFile(env);

  const load = (): { data: VaultFile; key: Buffer } => {
    const data = read(file);
    return { data, key: keyFor(env, data.salt) };
  };

  return {
    kind: 'file',
    async get(name) {
      assertSecretName(name);
      const { data, key } = load();
      const sealed = data.entries[name];
      if (!sealed) return null;
      return open(key, name, sealed);
    },
    async set(name, value) {
      assertSecretName(name);
      assertSecretValue(name, value);
      const { data, key } = load();
      data.entries[name] = seal(key, name, value);
      write(file, data);
    },
    async delete(name) {
      assertSecretName(name);
      const data = read(file);
      if (!(name in data.entries)) return false;
      delete data.entries[name];
      write(file, data);
      return true;
    },
    async list() {
      // Listing names needs no key: the names are not the secret.
      return Object.keys(read(file).entries).sort();
    },
  };
}

/** Constant-time compare, exported for the CLI's "is this the same value" check. */
export function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
