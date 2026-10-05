/**
 * The gateway's half of the connector the supervisor runs (slate R73vdX4bOO).
 *
 * The tunnel's connector token is an owner secret, `CLOUDFLARE_TUNNEL_TOKEN`,
 * bound pre-approved to the gateway's own `access.cloudflare` destination
 * (target `connector`). "Set it up for me" keeps it there; the supervisor
 * reads it at each spawn and hands it to cloudflared in its environment;
 * Remove forgets it.
 *
 * Whether the connector should run is read from the database by the
 * supervisor (`cloudflareConnectorPlan`): Cloudflare Access on, a tunnel in
 * the setup record, a token kept, and the owner hasn't chosen Cloudflare's
 * system service instead.
 *
 * The setup engine and the setting's Save reach the supervisor over its
 * control socket (`supervisorConnector`): `POST /connector {action}`.
 */
import { deleteOwnerSecret, findSecret, putOwnerSecret, readWebSetting, useOwnerSecret, type BuddiHost, type Vault } from '@buddi/core';
import type { Pool } from 'pg';
import { supervisorCall } from '../service.js';
import { CLOUDFLARE_SETTING_KEY, toCloudflareSetting } from './cloudflare.js';
import { CLOUDFLARE_SETUP_KEY, type SetupRecord } from './cloudflare-setup.js';
import { ACCESS_CLOUDFLARE_KIND, registerCloudflareTokenDestination } from './cloudflare-token.js';

export const CONNECTOR_TOKEN_SECRET = 'CLOUDFLARE_TUNNEL_TOKEN';
const TARGET = 'connector';

export type ConnectorState = 'running' | 'starting' | 'stopped' | 'missing-binary' | 'system-daemon';

/** What the supervisor answers on `/connector` (install's cloudflared.ts, ConnectorStatus). */
export interface ConnectorView {
  state: ConnectorState;
  mode: 'buddi' | 'system';
  systemDaemon: string | null;
  binary: { path: string; source: 'path' | 'downloaded' } | null;
  detail?: string | undefined;
  brew?: string | undefined;
  pid: number | null;
  log: string;
  removedBinary?: boolean | undefined;
}

/** What the setup engine needs of the connector. */
export interface ConnectorControl {
  saveToken(token: string): Promise<void>;
  forgetToken(): Promise<void>;
  /** Ask the supervisor to match the setting now; its status after. */
  sync(): Promise<ConnectorView>;
  /** Stop it and delete the binary buddi downloaded. */
  remove(): Promise<ConnectorView>;
}

export interface ConnectorTokenStore {
  has(): Promise<boolean>;
  put(value: string): Promise<void>;
  use(): Promise<string | null>;
  remove(): Promise<void>;
}

export function connectorTokenStore(pool: Pool, vault: Vault | undefined): ConnectorTokenStore {
  registerCloudflareTokenDestination();
  return {
    has: async () => (await findSecret(pool, CONNECTOR_TOKEN_SECRET)) !== null,
    async put(value) {
      if (!vault) throw new Error('This installation has no vault, so the connector token cannot be kept.');
      await putOwnerSecret(pool, vault, {
        name: CONNECTOR_TOKEN_SECRET,
        value: value.trim(),
        bindings: [{ kind: ACCESS_CLOUDFLARE_KIND, target: TARGET, rule: 'pre-approved' }],
      });
    },
    async use() {
      let value: string | null = null;
      const result = await useOwnerSecret(
        {
          pool,
          vault,
          plugin: 'access',
          buddi: { version: '0.0', plugin: 'access' } as unknown as BuddiHost,
          now: () => new Date(),
          deliverInto: (delivered) => { value = delivered; },
        },
        { name: CONNECTOR_TOKEN_SECRET, kind: ACCESS_CLOUDFLARE_KIND, target: TARGET },
      );
      return 'done' in result ? value : null;
    },
    async remove() {
      if (vault && (await findSecret(pool, CONNECTOR_TOKEN_SECRET)) !== null) await deleteOwnerSecret(pool, vault, CONNECTOR_TOKEN_SECRET);
    },
  };
}

/** Should the supervisor run the connector, and for which tunnel? */
export async function cloudflareConnectorPlan(pool: Pool): Promise<{ wanted: boolean; mode: 'buddi' | 'system'; tunnelId: string | null }> {
  const setting = toCloudflareSetting(await readWebSetting(pool, CLOUDFLARE_SETTING_KEY));
  const row = await readWebSetting<SetupRecord>(pool, CLOUDFLARE_SETUP_KEY);
  const record = row && typeof row === 'object' && typeof row.host === 'string' ? row : null;
  const mode = record?.connector === 'system' ? 'system' : 'buddi';
  const tunnelId = record?.tunnelId ?? null;
  const token = tunnelId ? (await findSecret(pool, CONNECTOR_TOKEN_SECRET)) !== null : false;
  return { wanted: setting.enabled && tunnelId !== null && token, mode, tunnelId };
}

/** The supervisor's `/connector`, or throws when it can't be reached. */
export function supervisorConnector(socket: string, tokens: ConnectorTokenStore): ConnectorControl {
  const ask = async (action: 'sync' | 'remove'): Promise<ConnectorView> => {
    const reply = await supervisorCall(socket, '/connector', 'POST', { action }, 200_000);
    if (reply.status !== 200) throw new Error((reply.body as { error?: string } | null)?.error ?? `The supervisor answered ${reply.status}.`);
    return reply.body as ConnectorView;
  };
  return {
    saveToken: (token) => tokens.put(token),
    forgetToken: () => tokens.remove(),
    sync: () => ask('sync'),
    remove: () => ask('remove'),
  };
}

/** Is a supervisor answering on this socket? */
export async function supervisorAnswers(socket: string | undefined): Promise<boolean> {
  if (!socket?.trim()) return false;
  return supervisorCall(socket, '/status', 'GET', undefined, 3_000).then((r) => r.status === 200, () => false);
}
