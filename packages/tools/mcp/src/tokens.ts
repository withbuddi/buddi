/**
 * A connection's tokens: one vault entry, the shared `OAuthTokens` envelope
 * (docs/connections.md, "Tokens"), refreshed under the shared discipline.
 *
 * The entry is `MCP_CONNECTION_<id>`. Its `extra.tokenEndpoint` says where a
 * refresh goes, so a refresh needs no discovery. Nothing here returns a token
 * to anything but the fetch that puts it in a header, and no error carries one.
 */
import type { Pool } from 'pg';
import type { OAuthPort, OAuthTokens, VaultPort } from './ports.js';

/** The vault name for a connection: environment-variable shaped, as every vault name is. */
export function vaultRefFor(connectionId: string): string {
  return `MCP_CONNECTION_${connectionId.replace(/-/g, '')}`;
}

/** The tokens are gone, expired without a refresh, or refused: the owner signs in again. */
export class ReconnectNeeded extends Error {
  override readonly name = 'ReconnectNeeded';
}

export interface TokenKeeperOptions {
  vault: VaultPort | undefined;
  oauth: OAuthPort;
  /** For the cross-process refresh lock. Without one, only this process is serialised. */
  pool?: Pick<Pool, 'connect'>;
  /** A token was saved or removed: the output scrubber rebuilds. */
  changed?: () => void;
}

const MESSAGES = {
  invalid: 'The saved sign-in for this connection cannot be read. Reconnect it.',
  missing: 'This connection has no sign-in. Reconnect it.',
  interrupted: 'The last renewal of this connection\'s sign-in did not finish. Reconnect it.',
  refreshFailed: 'The service refused to renew this connection\'s sign-in. Reconnect it.',
  unsaved: 'The renewed sign-in could not be saved. Reconnect this connection.',
  cannotRenew: 'This sign-in cannot be renewed. Reconnect this connection.',
};

export class TokenKeeper {
  readonly #inflight = new Map<string, Promise<OAuthTokens>>();
  constructor(readonly options: TokenKeeperOptions) {}

  get available(): boolean { return this.options.vault !== undefined; }

  #vault(): VaultPort {
    if (!this.options.vault) throw new Error('This installation has no vault, so a connection cannot keep its sign-in. Turn the vault on first.');
    return this.options.vault;
  }

  async save(ref: string, tokens: OAuthTokens): Promise<void> {
    await this.#vault().set(ref, JSON.stringify({ ...tokens, state: 'ready' }));
    this.options.changed?.();
  }

  async remove(ref: string): Promise<void> {
    await this.#vault().delete(ref);
    this.options.changed?.();
  }

  /** A fresh access token for `ref`, renewed first when it expires within five minutes. */
  async accessToken(ref: string): Promise<string> {
    let running = this.#inflight.get(ref);
    if (!running) {
      running = this.#fresh(ref).finally(() => this.#inflight.delete(ref));
      this.#inflight.set(ref, running);
    }
    return (await running).accessToken;
  }

  async #fresh(ref: string): Promise<OAuthTokens> {
    const run = (): Promise<OAuthTokens> => this.options.oauth.fresh(this.#vault(), ref, MESSAGES);
    try {
      if (!this.options.pool) return await run();
      const client = await this.options.pool.connect();
      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtext('buddi-mcp-oauth'), hashtext($1))", [ref]);
        const out = await run();
        await client.query('commit');
        return out;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const message = error instanceof Error && Object.values(MESSAGES).includes(error.message)
        ? error.message
        : 'This connection\'s sign-in could not be read. Reconnect it.';
      throw new ReconnectNeeded(message);
    }
  }
}
