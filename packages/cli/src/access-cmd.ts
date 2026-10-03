/**
 * `buddi access cloudflare setup --host <h> [--zone <z>] [--email <e>] [--adopt]` and
 * `buddi access cloudflare remove [--host <h>]`: Settings → Sign in from
 * elsewhere → Cloudflare Access → "Set it up for me", from the terminal.
 *
 * The same engine as the panel (`@buddi/gateway`'s cloudflare-setup), on the
 * same database: it writes the setting directly and the running gateway binds
 * its ingress listener within a quarter of a minute. The API token comes from
 * `CLOUDFLARE_API_TOKEN`, the owner secret kept by an earlier run, or a
 * prompt with echo off; it is kept as that owner secret for Remove and never
 * printed. The service install line is printed, never run.
 */
import { createPool, createVault, readWebSetting, writeWebSetting, VAULT_PLACEHOLDER } from '@buddi/core';
import {
  CLOUDFLARE_SETTING_KEY,
  CLOUDFLARE_SETUP_KEY,
  DEFAULT_WEB_PORT,
  WEB_PORT_VAR,
  createCloudflareApi,
  createJwks,
  ownerSecretTokenStore,
  removeCloudflareSetup,
  removedInWords,
  runCloudflareSetup,
  toCloudflareSetting,
  type SetupProgress,
  type SetupRecord,
} from '@buddi/gateway';
import { createInterface } from 'node:readline';
import { promptHidden } from './vault-cmd.js';
import { bold as boldOn, colorOn, dim as dimOn } from './style.js';

const color = colorOn();
const dim = (s: string): string => dimOn(s, color);
const bold = (s: string): string => boldOn(s, color);

/** Where cloudflared must point: `BUDDI_INGRESS_PORT`, or the dashboard's port + 2. */
export function ingressPortOf(env: NodeJS.ProcessEnv): number {
  const asked = Number(env.BUDDI_INGRESS_PORT?.trim() || NaN);
  if (Number.isInteger(asked) && asked > 0 && asked <= 65535) return asked;
  const web = Number(env[WEB_PORT_VAR]?.trim() || NaN);
  return (Number.isInteger(web) && web > 0 && web <= 65533 ? web : DEFAULT_WEB_PORT) + 2;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/** Prints each step once as it settles, and the install block when it appears. */
function printer(): (p: SetupProgress) => void {
  const said = new Set<string>();
  let installShown = false;
  return (p) => {
    for (const step of p.steps) {
      const key = `${step.id}:${step.state}`;
      if (said.has(key)) continue;
      if (step.state === 'done') { said.add(key); console.log(`  ✓ ${step.text}`); }
      if (step.state === 'failed') { said.add(key); console.log(`  ✗ ${step.text}\n    ${step.why ?? ''}`); }
      if (step.state === 'now' && step.id === 'healthy') { said.add(key); console.log(dim('  … waiting for the tunnel to connect (Ctrl-C stops waiting; what buddi made stays)')); }
    }
    if (p.install && !installShown) {
      installShown = true;
      console.log('');
      console.log(bold('  Run this once in a terminal on this computer (buddi never runs sudo itself):'));
      console.log('');
      console.log(`    ${p.install.command}`);
      console.log('');
      console.log(dim(`  ${p.install.note}`));
      console.log('');
    }
  };
}

export async function runAccess(
  command: { action: 'cloudflare-setup' | 'cloudflare-remove'; host?: string; zone?: string; email?: string; adopt?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set, so there is no database to write the setting to.');
    return 3;
  }
  const pool = createPool(databaseUrl);
  const tokens = ownerSecretTokenStore(pool, createVault({ env }));
  try {
    const fromEnv = env.CLOUDFLARE_API_TOKEN?.trim();
    let token = fromEnv && fromEnv !== VAULT_PLACEHOLDER ? fromEnv : null;
    if (token === null) token = await tokens.use().catch(() => null);
    if (token === null) {
      console.log('A Cloudflare API token with these permissions (My Profile → API Tokens → Create Token → Custom token):');
      console.log('  Account · Cloudflare Tunnel · Edit');
      console.log('  Account · Access: Apps and Policies · Edit');
      console.log('  Account · Access: Organizations, Identity Providers, and Groups · Read');
      console.log('  Zone · DNS · Edit — on the zone of your hostname');
      token = (await promptHidden('Cloudflare API token (input hidden): ')).trim();
      if (token === '') { console.error('No token given.'); return 2; }
    }
    const api = createCloudflareApi({ token });
    const readSetting = async () => toCloudflareSetting(await readWebSetting(pool, CLOUDFLARE_SETTING_KEY));
    const saveSetting = (value: unknown) => writeWebSetting(pool, CLOUDFLARE_SETTING_KEY, value);
    const readRecord = async (): Promise<SetupRecord | null> => {
      const row = await readWebSetting<SetupRecord>(pool, CLOUDFLARE_SETUP_KEY);
      return row && typeof row.host === 'string' ? row : null;
    };
    const saveRecord = (record: SetupRecord | null) => writeWebSetting(pool, CLOUDFLARE_SETUP_KEY, record);

    if (command.action === 'cloudflare-remove') {
      const done = await removeCloudflareSetup({ api, platform: process.platform, readSetting, saveSetting, readRecord, saveRecord, host: command.host });
      if (done.removed.length) console.log(`Removed ${removedInWords(done.removed)}.`);
      if (done.error) { console.error(done.error); return 1; }
      await tokens.remove().catch(() => undefined);
      console.log(`To remove the connector from this computer too: ${done.uninstall}`);
      return 0;
    }

    // Kept for Remove, from the panel or here.
    await tokens.put(token).catch(() => {
      console.error(dim('(The token could not be kept in the vault; Remove will ask for it again.)'));
    });
    let email = command.email?.trim() || (await readSetting()).email || '';
    if (!email) email = (await ask('Your email (the one Cloudflare will let in): ')).trim();

    const abort = new AbortController();
    const onSigint = (): void => abort.abort();
    process.once('SIGINT', onSigint);
    const jwks = createJwks();
    const done = await runCloudflareSetup(
      { host: command.host ?? '', email, zone: command.zone, adopt: command.adopt === true },
      {
        api,
        ingressPort: ingressPortOf(env),
        platform: process.platform,
        readSetting,
        saveSetting,
        readRecord,
        saveRecord,
        test: (team) => jwks.refresh(team),
        signal: abort.signal,
      },
      printer(),
    ).finally(() => process.removeListener('SIGINT', onSigint));
    if (done.state === 'done') {
      console.log('');
      console.log(`Done. Open ${done.url} from another device and sign in as ${email}.`);
      console.log(dim('The running buddi picks the setting up within 15 seconds.'));
      return 0;
    }
    if (done.state === 'stopped') { console.log(done.error ?? 'Stopped.'); return 0; }
    console.error('');
    console.error(done.error ?? 'The setup did not finish.');
    if (done.adoptable) console.error(dim('To use it anyway, run the same command again with --adopt.'));
    console.error(dim('Run it again to pick up where it stopped, or `buddi access cloudflare remove` to undo what buddi made.'));
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
