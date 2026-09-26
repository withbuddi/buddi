/**
 * Ollama Cloud, connected with a device key (buddi-planning
 * specs/ollama-connect.md): buddi makes an ed25519 key pair, the owner presses
 * Connect on ollama.com, and from then on each request to ollama.com is signed
 * with the key. Nobody ever sees a key.
 *
 * The key pair lives in the vault, under the account's own name, as one JSON
 * envelope. Postgres holds only that the account signs in this way.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Vault } from '@buddi/core';
import { OllamaConnectProtocol, generateOllamaDeviceKey, ollamaConnectUrl, ollamaPublicKey } from '@buddi/runtime';
import type { Pool } from 'pg';

/** What the vault holds for one connected (or connecting) device. */
export interface OllamaDeviceEnvelope {
  version: 1;
  /** PKCS8 PEM. Never leaves the gateway. */
  privateKey: string;
  /** The authorized_keys line ollama.com shows under "Show key". */
  publicKey: string;
  /** What ollama.com lists the device as. */
  deviceName: string;
  createdAt: string;
  /** Set the first time ollama.com answered with an account for this key. */
  connectedAt: string | null;
  /** The ollama.com account the key is connected to, as the server said. */
  username: string | null;
}

/** What may be shown about a device: never the private key. */
export interface OllamaDeviceView {
  deviceName: string;
  username: string | null;
  connectedAt: string | null;
}

export function readOllamaDevice(raw: string): OllamaDeviceEnvelope {
  try {
    if (raw.length > 16384) throw new Error();
    const data = JSON.parse(raw) as OllamaDeviceEnvelope;
    if (data.version !== 1 || typeof data.privateKey !== 'string' || typeof data.publicKey !== 'string' ||
      typeof data.deviceName !== 'string' || typeof data.createdAt !== 'string' ||
      !(data.connectedAt === null || typeof data.connectedAt === 'string') ||
      !(data.username === null || typeof data.username === 'string')) throw new Error();
    // The public key is derived again rather than trusted, so the two can never disagree.
    if (ollamaPublicKey(data.privateKey) !== data.publicKey) throw new Error();
    return data;
  } catch { throw new Error('Invalid Ollama device key. Connect this account again.'); }
}

export function deviceView(device: OllamaDeviceEnvelope): OllamaDeviceView {
  return { deviceName: device.deviceName, username: device.username, connectedAt: device.connectedAt };
}

/** "connected as amen, device buddi on studio": the line status and the card show. */
export function connectedLine(device: OllamaDeviceView): string {
  return device.connectedAt
    ? `connected as ${device.username || 'an ollama.com account'}, device ${device.deviceName}`
    : `not connected yet, device ${device.deviceName}`;
}

/** "buddi on <this computer>", without the `.local` macOS adds. */
export function ollamaDeviceName(host: string = hostname()): string {
  const short = host.replace(/\.local$/i, '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
  return short ? `buddi on ${short}` : 'buddi';
}

/** How long a connect attempt waits for the owner to press Connect. */
export const OLLAMA_CONNECT_TTL_MS = 15 * 60_000;

interface Pending { attemptId: string; owner: string; revision: number; expiresAt: number; url: string; deviceName: string }

export type OllamaPoll =
  | { state: 'connected'; username: string; deviceName: string }
  | { state: 'waiting'; expiresAt: string }
  | { state: 'failed'; message: string };

/** Caller serialises account operations; this holds only the in-flight attempts. */
export class OllamaAccounts {
  #pending = new Map<string, Pending>();
  constructor(
    readonly vault: Vault,
    readonly protocol = new OllamaConnectProtocol(),
    readonly now = Date.now,
    readonly deviceName = ollamaDeviceName,
  ) {}

  #prune() { for (const [id, p] of this.#pending) if (p.expiresAt <= this.now()) this.#pending.delete(id); }

  /** A new key pair into the vault, and the page the owner presses Connect on. */
  async start(id: string, revision: number, owner: string, ref: string) {
    this.#prune();
    if (this.#pending.size >= 128 && !this.#pending.has(id)) throw new Error('Too many connections waiting. Cancel one or wait 15 minutes.');
    const key = generateOllamaDeviceKey();
    const name = this.deviceName();
    const envelope: OllamaDeviceEnvelope = {
      version: 1, privateKey: key.privateKey, publicKey: key.publicKey, deviceName: name,
      createdAt: new Date(this.now()).toISOString(), connectedAt: null, username: null,
    };
    try { await this.vault.set(ref, JSON.stringify(envelope)); }
    catch { throw new Error('Could not save the Ollama device key securely. Unlock the vault and try again.'); }
    this.#pending.set(id, { attemptId: randomUUID(), owner, revision, expiresAt: this.now() + OLLAMA_CONNECT_TTL_MS, url: ollamaConnectUrl(key.publicKey, name), deviceName: name });
    return this.view(id, revision, owner)!;
  }

  view(id: string, revision: number, owner?: string) {
    this.#prune(); const p = this.#pending.get(id);
    return p && p.owner === owner && p.revision === revision ? {
      state: 'pending' as const, attemptId: p.attemptId, verificationUrl: p.url, deviceName: p.deviceName,
      expiresAt: new Date(p.expiresAt).toISOString(),
    } : null;
  }

  forget(id: string) { this.#pending.delete(id); }

  /** One signed request: has the owner pressed Connect yet? */
  async poll(id: string, revision: number, owner: string, attemptId: string, ref: string): Promise<OllamaPoll> {
    const p = this.#pending.get(id);
    if (!p || p.owner !== owner || p.revision !== revision || p.attemptId !== attemptId) {
      return { state: 'failed', message: 'This connection changed or belongs to another session. Connect again.' };
    }
    if (p.expiresAt <= this.now()) {
      this.#pending.delete(id);
      return { state: 'failed', message: 'The 15 minutes to press Connect ran out. Connect again.' };
    }
    const device = await this.#device(ref);
    const answer = await this.protocol.whoami(device.privateKey);
    if (answer.state === 'waiting') return { state: 'waiting', expiresAt: new Date(p.expiresAt).toISOString() };
    this.#pending.delete(id);
    if (answer.state === 'failed') return answer;
    const connected: OllamaDeviceEnvelope = { ...device, connectedAt: new Date(this.now()).toISOString(), username: answer.username };
    try { await this.vault.set(ref, JSON.stringify(connected)); }
    catch { return { state: 'failed', message: 'Connected, but the vault refused the update. Unlock it and connect again.' }; }
    return { state: 'connected', username: answer.username, deviceName: device.deviceName };
  }

  async #device(ref: string): Promise<OllamaDeviceEnvelope> {
    let raw: string | null;
    try { raw = await this.vault.get(ref); }
    catch { throw new Error('The credential vault is unavailable or locked. Unlock it on the host and retry.'); }
    if (!raw) throw new Error('Connect this Ollama account first.');
    return readOllamaDevice(raw);
  }

  /**
   * Ask ollama.com to forget this device before the key is dropped, as
   * `ollama signout` does. Best effort: false when it could not be asked or
   * said no, and the caller removes the key either way.
   */
  async unpair(ref: string): Promise<boolean> {
    let device: OllamaDeviceEnvelope;
    try { device = await this.#device(ref); } catch { return false; }
    if (!device.connectedAt) return false;
    return this.protocol.forget(device.privateKey);
  }

  /** The private key a run signs with, once the device is connected. */
  async credential(ref: string): Promise<string> {
    const device = await this.#device(ref);
    if (!device.connectedAt) throw new Error('Connect this Ollama account first.');
    return device.privateKey;
  }
}

/**
 * The connected devices, for `buddi status`: read straight from the rows and
 * the raw vault (a device envelope is never an owner secret). A device that
 * cannot be read is left out, not guessed at.
 */
export async function readOllamaDevices(pool: Pick<Pool, 'query'>, vault: Vault | undefined): Promise<Array<{ label: string } & OllamaDeviceView>> {
  if (!vault) return [];
  const { rows } = await pool.query(`select label, secret_ref as "secretRef" from core.provider_accounts
    where auth = 'device-key' and deleting = false order by created_at, id`);
  const found: Array<{ label: string } & OllamaDeviceView> = [];
  for (const row of rows as Array<{ label: string; secretRef: string | null }>) {
    if (!row.secretRef) continue;
    try {
      const raw = await vault.get(row.secretRef);
      if (raw) found.push({ label: row.label, ...deviceView(readOllamaDevice(raw)) });
    } catch { /* unreadable: left out */ }
  }
  return found;
}
