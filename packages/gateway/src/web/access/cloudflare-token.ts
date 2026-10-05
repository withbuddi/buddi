/**
 * The Cloudflare API token "Set it up for me" uses, kept as an owner secret
 * (docs/owner-secrets.md): a row named `CLOUDFLARE_API_TOKEN`, its value in
 * the vault, bound pre-approved to the gateway's own `access.cloudflare`
 * destination because the owner pasted it into this very panel (or the CLI's
 * hidden prompt). Saving it primes the scrubber, so the value is masked in
 * every log line and tool result from then on.
 *
 * Read once per setup or Remove run, through `useOwnerSecret` with the value
 * delivered straight into the caller (the use is recorded like any other),
 * and held only for that run.
 */
import {
  deleteOwnerSecret,
  findSecret,
  primeSecretScrubber,
  putOwnerSecret,
  registerSecretDestination,
  secretDestination,
  useOwnerSecret,
  type BuddiHost,
  type Vault,
} from '@buddi/core';
import type { Pool } from 'pg';
import { CLOUDFLARE_TOKEN_SECRET } from './cloudflare-setup.js';

export const ACCESS_CLOUDFLARE_KIND = 'access.cloudflare';
const TARGET = 'setup';

/** The gateway's destination for the token. Delivered only into the gateway itself. */
export function registerCloudflareTokenDestination(): void {
  if (secretDestination(ACCESS_CLOUDFLARE_KIND)) return;
  registerSecretDestination('access', {
    kind: ACCESS_CLOUDFLARE_KIND,
    maxRule: 'pre-approved',
    checkTarget: (target) => target === TARGET || target === 'connector',
    describe: () => 'Cloudflare setup (Settings → Sign in from elsewhere)',
    deliver() {
      throw new Error('access.cloudflare delivers through the gateway itself, never through a destination');
    },
  });
}

export interface CloudflareTokenStore {
  /** Is one stored? */
  has(): Promise<boolean>;
  put(value: string): Promise<void>;
  /** The value, for one run; null when none is stored or it cannot be read. */
  use(): Promise<string | null>;
  remove(): Promise<void>;
}

export function ownerSecretTokenStore(pool: Pool, vault: Vault | undefined): CloudflareTokenStore {
  registerCloudflareTokenDestination();
  return {
    has: async () => (await findSecret(pool, CLOUDFLARE_TOKEN_SECRET)) !== null,
    async put(value) {
      if (!vault) throw new Error('This installation has no vault, so the token cannot be kept.');
      await putOwnerSecret(pool, vault, {
        name: CLOUDFLARE_TOKEN_SECRET,
        value: value.trim(),
        bindings: [{ kind: ACCESS_CLOUDFLARE_KIND, target: TARGET, rule: 'pre-approved' }],
      });
      await primeSecretScrubber();
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
        { name: CLOUDFLARE_TOKEN_SECRET, kind: ACCESS_CLOUDFLARE_KIND, target: TARGET },
      );
      return 'done' in result ? value : null;
    },
    async remove() {
      if (vault) await deleteOwnerSecret(pool, vault, CLOUDFLARE_TOKEN_SECRET);
    },
  };
}

/** A store in memory: tests. */
export function memoryTokenStore(initial: string | null = null): CloudflareTokenStore & { value: string | null } {
  const store = {
    value: initial,
    has: async () => store.value !== null,
    put: async (value: string) => { store.value = value.trim(); },
    use: async () => store.value,
    remove: async () => { store.value = null; },
  };
  return store;
}
