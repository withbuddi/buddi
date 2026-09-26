/**
 * `buddi uninstall`, in a source checkout.
 *
 * A checkout is the owner's own folder, so this removes only what buddi put
 * elsewhere on the machine: the background service, the secrets in the
 * keychain (the file vault on Linux), the dashboard app, the Telegram menu,
 * and it stops the Docker Postgres with the same `docker compose down` as
 * `buddi db down`. The repository, its `.env`, the data folder and the
 * database volume are left, and the command says so.
 *
 * A packaged install answers this command in its launcher (`@buddi/install`),
 * which also removes the data directory. The flow both share — print, ask,
 * back up, remove, report — is `@buddi/core/uninstall`.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runUninstallPlan } from '@buddi/core/uninstall';
import type { RemovalStep, UninstallIo } from '@buddi/core/uninstall';

export interface CheckoutUninstallOptions {
  yes: boolean;
  keepData: boolean;
  backup: boolean;
}

export interface CheckoutUninstallDeps {
  platform: NodeJS.Platform | string;
  repoRoot: string;
  dataDir: string;
  backupDir: string;
  /** The launchd agent or systemd user unit, when its file is there. */
  service?: {
    line: string;
    /** Stops and unloads it and deletes the unit file; throws when it is still running after. */
    uninstall: () => Promise<void>;
  };
  /** `docker compose down` for the checkout's Postgres, when Docker is running. */
  database?: { down: () => Promise<void> };
  keychain?: { service: string; names: () => Promise<string[]>; purge: (names: string[]) => Promise<void> };
  /** The file vault, where there is no keychain. Its key is in `.env`, which stays. */
  fileVault?: string;
  removeFile: (file: string) => Promise<void>;
  /** `buddi backup create --encrypt`; throws when it did not write an archive. */
  backup: () => Promise<void>;
  passphrase: () => Promise<string | undefined>;
  telegram?: { collect: () => Promise<() => Promise<void>> };
  app?: string;
  io: UninstallIo;
}

export async function uninstallCheckout(options: CheckoutUninstallOptions, deps: CheckoutUninstallDeps): Promise<number> {
  const steps: RemovalStep[] = [];
  if (deps.service) steps.push({ line: deps.service.line, run: deps.service.uninstall });
  if (deps.database) {
    steps.push({ line: `the Docker Postgres, stopped with docker compose down in ${deps.repoRoot}`, run: deps.database.down });
  }
  const secretsGo = !options.keepData;
  if (secretsGo && deps.keychain) {
    const keychain = deps.keychain;
    let names: string[] = [];
    let unreadable: string | undefined;
    try { names = await keychain.names(); } catch (error) { unreadable = (error as Error).message; }
    if (names.length > 0 || unreadable !== undefined) {
      steps.push({
        line: unreadable !== undefined
          ? `secrets: the keychain entries under ${keychain.service} (they could not be listed: ${unreadable.replace(/\.$/, '')})`
          : `secrets: ${names.length} keychain ${names.length === 1 ? 'entry' : 'entries'} under ${keychain.service}: ${names.join(', ')}`,
        run: async () => {
          if (unreadable !== undefined) throw new Error(unreadable);
          // Again at the time of removal: the last backup may have just made the passphrase entry.
          const now = await keychain.names().catch(() => names);
          await keychain.purge([...new Set([...names, ...now])]);
        },
      });
    }
  }
  if (secretsGo && deps.fileVault !== undefined) {
    const file = deps.fileVault;
    steps.push({ line: `secrets: the file vault ${file}`, run: () => deps.removeFile(file) });
  }
  if (deps.app !== undefined) {
    const app = deps.app;
    steps.push({ line: `the dashboard app ${app}`, run: () => deps.removeFile(app) });
  }
  let clearMenu: (() => Promise<void>) | undefined;
  if (deps.telegram) {
    steps.push({
      line: "the Telegram bot's command menu",
      bestEffort: true,
      run: async () => {
        if (!clearMenu) throw new Error('the paired chats could not be read');
        await clearMenu();
      },
    });
  }

  const notes: string[] = [];
  const backingUp = options.backup && steps.length > 0;
  if (backingUp) notes.push(`First it takes one last backup, into ${deps.backupDir}, where it stays.`);
  notes.push(
    `Left alone: the repository ${deps.repoRoot}, its .env, the data in ${deps.dataDir}, and the database volume` +
      (secretsGo ? ' (its password goes with the secrets, so run docker compose down -v in the repository before a fresh buddi init).' : ', with the secrets that open it.'),
  );

  return await runUninstallPlan({
    heading: `This removes buddi's service and secrets from ${deps.platform === 'darwin' ? 'this Mac' : 'this machine'}:`,
    steps,
    notes,
    prepare: async () => {
      const lines: string[] = [];
      if (backingUp) {
        deps.io.log('Taking one last backup.');
        await deps.backup();
        lines.push(`The backup is in ${deps.backupDir}. It stays.`);
        if (secretsGo) {
          const phrase = await deps.passphrase().catch(() => undefined);
          if (phrase !== undefined) {
            lines.push(`It is locked with your backup passphrase, and the vault that keeps it is going: ${phrase}`);
            lines.push('Write the six words down. Nothing else opens that backup.');
          }
        }
      }
      if (deps.telegram) clearMenu = await deps.telegram.collect().catch(() => undefined);
      return lines;
    },
  }, { yes: options.yes }, deps.io);
}

/** The real checkout: the service manager, Docker, the keychain, the backup engine. */
export async function runUninstall(options: CheckoutUninstallOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const core = await import('@buddi/core');
  const { purgeKeychain, clearTelegramMenu } = await import('@buddi/core/uninstall');
  const { REPO_ROOT, DATA_DIR, BACKUP_DIR, CLI_ENTRY } = await import('./paths.js');
  const { createServiceManager } = await import('./service/index.js');
  const { dockerState, runDb } = await import('./db-cmd.js');
  const { runBackup } = await import('./backup/index.js');
  const { dashboardAppOwnedBy } = await import('./dashboard-app.js');

  const manager = (() => { try { return createServiceManager(); } catch { return undefined; } })();
  const selection = core.vaultSelection({ env });
  const keychainService = env.BUDDI_VAULT_SERVICE?.trim() || core.VAULT_SERVICE;
  const fileVault = core.defaultVaultFile(env);
  const composeFile = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].some((name) => existsSync(path.join(REPO_ROOT, name)));
  const docker = composeFile ? await dockerState() : { state: 'absent' as const };
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const app = dashboardAppOwnedBy(CLI_ENTRY, os.homedir());
  const vault = (() => { try { return core.createVault({ env }); } catch { return undefined; } })();

  return await uninstallCheckout(options, {
    platform: process.platform,
    repoRoot: REPO_ROOT,
    dataDir: DATA_DIR,
    backupDir: BACKUP_DIR,
    ...(manager && existsSync(manager.unitPath) ? {
      service: {
        line: manager.kind === 'launchd'
          ? `the background service: launchd agent com.buddi.serve (${manager.unitPath})`
          : `the background service: systemd user unit com.buddi.serve.service (${manager.unitPath})`,
        uninstall: async () => {
          await manager.uninstall();
          const after = await manager.status();
          if (after.running) throw new Error(`${manager.kind} still runs it${after.pid ? ` (pid ${after.pid})` : ''}`);
        },
      },
    } : {}),
    ...(docker.state === 'running' ? {
      database: {
        down: async () => {
          const code = await runDb('down', env);
          if (code !== 0) throw new Error(`docker compose down exited ${code}`);
        },
      },
    } : {}),
    ...(selection === 'keychain' ? {
      keychain: {
        service: keychainService,
        names: () => core.createKeychainVault({ service: keychainService }).list(),
        purge: (names: string[]) => purgeKeychain(keychainService, names, core.defaultRunSecurity),
      },
    } : {}),
    ...(selection === 'file' && existsSync(fileVault) ? { fileVault } : {}),
    removeFile: (file) => rm(file, { recursive: true, force: true }),
    backup: async () => {
      const code = await runBackup({ action: 'create', encrypt: true }, env);
      if (code !== 0) throw new Error('The last backup did not finish. Start the database with buddi db up, or run buddi uninstall --no-backup.');
    },
    passphrase: async () => (await vault?.get(core.BACKUP_PASSPHRASE_KEY)) ?? undefined,
    ...(token && !token.startsWith('<') ? {
      telegram: {
        collect: async () => {
          const pool = core.createPool(env.DATABASE_URL as string);
          try {
            const paired = await core.listSurfaceIdentities(pool, 'telegram');
            const chats = paired.map((identity) => identity.externalChatId).filter((id): id is string => typeof id === 'string' && id !== '');
            const { defaultHttpTransport } = await import('@buddi/gateway');
            return () => clearTelegramMenu(token, chats, defaultHttpTransport);
          } finally {
            await pool.end().catch(() => {});
          }
        },
      },
    } : {}),
    ...(app === undefined ? {} : { app }),
    io: {
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      ask: async (question) => {
        if (process.stdin.isTTY !== true) return undefined;
        const readline = await import('node:readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try { return (await rl.question(question)).trim(); } finally { rl.close(); }
      },
    },
  });
}
