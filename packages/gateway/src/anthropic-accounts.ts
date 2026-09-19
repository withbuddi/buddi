import { randomUUID } from 'node:crypto';
import type { Vault } from '@buddi/core';
import { AnthropicOAuthProtocol, createAnthropicLogin, parseAnthropicCode, readAnthropicTokens } from '@buddi/runtime';

interface Pending {
  id: string; owner: string; revision: number; expiresAt: number;
  verifier: string; state: string; authorizeUrl: string;
}
/** Caller holds the cross-process account lock for all credential operations. */
export class AnthropicAccounts {
  #pending = new Map<string, Pending>();
  constructor(readonly vault: Vault, readonly protocol = new AnthropicOAuthProtocol(), readonly now = Date.now) {}
  #prune() { for (const [id, p] of this.#pending) if (p.expiresAt <= this.now()) this.#pending.delete(id); }
  start(id: string, revision: number, owner: string) {
    this.#prune();
    if (this.#pending.size >= 128 && !this.#pending.has(id)) throw new Error('Too many pending sign-ins. Cancel one or wait for expiry.');
    this.#pending.set(id, { ...createAnthropicLogin(), id: randomUUID(), owner, revision, expiresAt: this.now() + 15 * 60_000 });
    return this.view(id, revision, owner);
  }
  view(id: string, revision: number, owner?: string) {
    this.#prune(); const p = this.#pending.get(id);
    return p && p.owner === owner && p.revision === revision ? {
      state: 'pending' as const, attemptId: p.id, verificationUrl: p.authorizeUrl, expiresAt: new Date(p.expiresAt).toISOString(),
    } : null;
  }
  forget(id: string) { this.#pending.delete(id); }
  async finish(id: string, revision: number, owner: string, attemptId: string, pasted: string, ref: string) {
    this.#prune(); const p = this.#pending.get(id);
    if (!p || p.owner !== owner || p.revision !== revision || p.id !== attemptId) throw new Error('Sign-in expired, changed, or belongs to another session. Start again.');
    this.#pending.delete(id); // Single attempt, including network failures and bad pastes.
    const parsed = parseAnthropicCode(pasted, p.state);
    const tokens = await this.protocol.exchange({ ...parsed, verifier: p.verifier });
    try { await this.vault.set(ref, JSON.stringify(tokens)); }
    catch { throw new Error('Could not save Claude credentials securely. Unlock the vault and reconnect.'); }
  }
  async credential(ref: string): Promise<string> {
    const raw = await this.vault.get(ref);
    if (!raw) throw new Error('Connect this Claude subscription account first.');
    const tokens = readAnthropicTokens(raw);
    if (tokens.state !== 'ready') throw new Error('Claude token refresh was interrupted or failed. Reconnect this account.');
    if (tokens.expiresAt > this.now() + 5 * 60_000) return tokens.accessToken;
    // A durable marker prevents another process replaying a consumed refresh
    // token after a crash, timeout, or failure to save the rotated pair.
    await this.vault.set(ref, JSON.stringify({ ...tokens, state: 'refreshing' }));
    const rotated = await this.protocol.refresh(tokens);
    try { await this.vault.set(ref, JSON.stringify(rotated)); }
    catch { throw new Error('Claude credentials rotated but could not be saved. Reconnect this account.'); }
    return rotated.accessToken;
  }
}
