/**
 * `buddi init` — the wizard that turns a clone into a working installation.
 *
 * Idempotent by construction: every step asks only about what is *missing*, and
 * a second run on a finished machine asks nothing and simply re-checks. It
 * writes `.env`, brings up postgres, builds, and migrates — and it never prints
 * a secret back, not even the one it just read.
 *
 * It installs no system software. Node, pnpm and docker are checked and named;
 * installing them is the owner's call, on the owner's package manager.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import {
  DATABASE_URL_VAR,
  DB_PASSWORD_VAR,
  KNOWN_SECRETS,
  assembleDatabaseUrl,
  createPool,
  createVault,
  databaseDefaults,
  resolveDatabaseUrl,
  resolveSecrets,
  type Vault,
} from '@buddi/core';
import { createPairingCode, listDevices, TelegramApi } from '@buddi/gateway';
import { getOnboarding } from '@buddi/core';
import { runDashboard } from './dashboard-cmd.js';
import { ensureDatabasePassword, shape } from './db-secure.js';
import { applyEnvEdits, isBlank, maskSecret, parseEnv, type EnvEdit } from './env-file.js';
import {
  isNoop,
  nextSteps,
  planInit,
  renderPlan,
  stepOf,
  willRun,
  type InitFacts,
  type PlannedStep,
} from './init-plan.js';
import { ENV_EXAMPLE_FILE, ENV_FILE, REPO_ROOT } from './paths.js';
import { run, runInherit, versionOf } from './proc.js';
import { createServiceManager } from './service/index.js';
import { renderQr } from './telegram-cmd.js';

const ESC = '\u001b[';
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}0m`;

const MIN_NODE_MAJOR = 22;
export interface InitOptions {
  /** Injected in tests; defaults to a real readline over stdin/stdout. */
  ask?: (question: string) => Promise<string>;
  /** Injected in tests; defaults to this machine's vault. */
  vault?: Vault | undefined;
  /**
   * `--yes`. Ask nothing: take the default for every step that only needs
   * consent, and skip every step that needs something typed.
   */
  yes?: boolean;
  /**
   * Whether the owner can be asked anything. Defaults to "there is a TTY on
   * both ends and `--yes` was not passed"; injected in tests.
   */
  interactive?: boolean;
  /** Injected in tests. Real runs open a browser via `buddi dashboard`. */
  openDashboard?: () => Promise<number>;
}

/** How long `init` waits for a device to scan the QR before moving on. */
export const PAIR_WAIT_MS = 120_000;

/** How often it asks the database whether the pairing landed. */
export const PAIR_POLL_MS = 2_000;

export async function runInit(opts: InitOptions = {}): Promise<number> {
  const assumeYes = opts.yes === true;
  const interactive =
    opts.interactive ??
    (!assumeYes &&
      (opts.ask !== undefined ||
        (process.stdin.isTTY === true && process.stdout.isTTY === true)));

  const rl =
    opts.ask !== undefined || !interactive
      ? undefined
      : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = opts.ask ?? (rl ? (q: string) => rl.question(q) : async () => '');

  /** A yes/no gate. Non-interactive answers with `--yes` and never blocks. */
  const confirm = async (question: string, byDefault = true): Promise<boolean> => {
    if (!interactive) return assumeYes;
    const answer = (await ask(`${question} [${byDefault ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
    if (answer === '') return byDefault;
    return answer === 'y' || answer === 'yes';
  };

  try {
    console.log(bold('buddi init'));
    console.log(dim(`installation: ${REPO_ROOT}`));
    if (!interactive) {
      console.log(dim(assumeYes ? '--yes: nothing will be asked' : 'no terminal: nothing will be asked'));
    }
    console.log();

    /* 1. Prerequisites — named, never installed. */
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor < MIN_NODE_MAJOR) {
      console.error(
        `Node ${process.versions.node} is too old — buddi needs ${MIN_NODE_MAJOR} or newer. ` +
          'Install it (https://nodejs.org or `brew install node`) and run `buddi init` again.',
      );
      return 1;
    }
    console.log(`  node    ${process.versions.node}`);

    const pnpmVersion = await versionOf('pnpm');
    if (!pnpmVersion) {
      console.error('pnpm is not on PATH. Install it (https://pnpm.io/installation) and re-run.');
      return 1;
    }
    console.log(`  pnpm    ${pnpmVersion}`);

    const dockerVersion = await versionOf('docker');
    console.log(
      dockerVersion
        ? `  docker  ${dockerVersion}`
        : `  docker  ${dim('not found — install Docker Desktop, or point DATABASE_URL at your own postgres')}`,
    );
    console.log();

    /* 2. .env exists. */
    const envFileExisted = existsSync(ENV_FILE);
    if (!envFileExisted) {
      if (!existsSync(ENV_EXAMPLE_FILE)) {
        console.error(`neither ${ENV_FILE} nor ${ENV_EXAMPLE_FILE} exists — is this a buddi clone?`);
        return 1;
      }
      copyFileSync(ENV_EXAMPLE_FILE, ENV_FILE);
      console.log(`created ${ENV_FILE} from .env.example`);
    }

    let text = readFileSync(ENV_FILE, 'utf8');
    let env = parseEnv(text);

    /*
     * A secret the owner already moved into the vault leaves `NAME=<vault>`
     * behind in `.env` — a marker, not a value. Ask about what is missing only
     * after the vault has had its say, so a second run on a keychain-backed
     * installation asks nothing. Vault values are never written back to the
     * file: only what the owner types here becomes an edit.
     */
    const vault = opts.vault ?? createVault({ env: process.env });
    const secrets = await resolveSecrets(KNOWN_SECRETS, { vault, env });
    const locked = Object.values(secrets.problems).find((p) => p.code === 'vault-locked');
    if (locked) {
      console.error(`The vault is locked: ${locked.message}`);
      console.error('Unlock it and run `buddi init` again — nothing was changed.');
      return 1;
    }
    const known = secrets.env as Record<string, string>;

    const edits: EnvEdit[] = [];
    const remember = (key: string, value: string): void => {
      edits.push({ key, value });
      env[key] = value;
      known[key] = value;
    };

    /*
     * 2b. The database's own password.
     *
     * Generated here, before anything starts the container, because `initdb`
     * reads `POSTGRES_PASSWORD` exactly once — on the first start of a fresh
     * volume. A machine set up by this wizard therefore never has the password
     * this project used to ship with, and the value never touches `.env`: it
     * goes into the vault, and `DATABASE_URL` is assembled around it at
     * runtime. An owner who set `DATABASE_URL` explicitly is left alone.
     */
    const databaseUrl = await setUpDatabasePassword(vault, env, { log: console.log });

    /*
     * 3. The plan. Everything above was gathering facts; from here the wizard
     *    is driven by `planInit`, so what it is about to do can be printed
     *    first and asserted in a test without a machine.
     */
    const facts = async (): Promise<InitFacts> => ({
      interactive,
      assumeYes,
      envFileExists: envFileExisted,
      hasModelCredential:
        !isBlank(known, 'CLAUDE_CODE_OAUTH_TOKEN') || !isBlank(known, 'ANTHROPIC_API_KEY'),
      hasBotToken: !isBlank(known, 'TELEGRAM_BOT_TOKEN'),
      hasTimezone: !isBlank(env, 'BUDDI_TZ'),
      hasOwnerName: !isBlank(env, 'BUDDI_OWNER_NAME'),
      hasPrivateAgents: hasPrivateAgents({ ...env, ...known }),
      hasDocker: dockerVersion !== undefined,
      pairedDevices: await countPairedDevices(databaseUrl),
      serviceInstalled: await serviceIsInstalled(),
      dashboardEnabled: (env.BUDDI_WEB ?? '1').trim() !== '0',
      onboardingPending: await onboardingIsPending(databaseUrl),
    });

    let plan = planInit(await facts());
    console.log(bold('Plan'));
    console.log(renderPlan(plan));
    if (isNoop(plan)) {
      console.log(dim('\nnothing left to do — re-running changes nothing.'));
    }

    /* 4. Model credential. */
    if (willRun(plan, 'model-credential')) {
      console.log(bold('\nModel credential'));
      console.log(
        'Two ways in:\n' +
          '  1. Claude subscription — run `claude setup-token` in another shell. It prints a\n' +
          '     token starting sk-ant-oat01-…; your Pro/Max subscription pays for the usage.\n' +
          '  2. API key — an sk-ant-api03-… key from console.anthropic.com, billed per token.',
      );
      const choice = (await ask('Which? [1/2] ')).trim();
      if (choice === '2') {
        const key = (await ask('ANTHROPIC_API_KEY: ')).trim();
        if (key !== '') remember('ANTHROPIC_API_KEY', key);
      } else {
        const token = (await ask('CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`): ')).trim();
        if (token !== '') remember('CLAUDE_CODE_OAUTH_TOKEN', token);
      }
      const got = known.CLAUDE_CODE_OAUTH_TOKEN ?? known.ANTHROPIC_API_KEY ?? '';
      console.log(got === '' ? dim('  (left empty — buddi chat will refuse to start)') : `  stored ${maskSecret(got)}`);
    } else if (stepOf(plan, 'model-credential').action === 'done') {
      const kind = !isBlank(known, 'CLAUDE_CODE_OAUTH_TOKEN')
        ? 'CLAUDE_CODE_OAUTH_TOKEN'
        : 'ANTHROPIC_API_KEY';
      console.log(`\nModel credential: ${kind} already set ${dim(`(${sourceOf(secrets.sources[kind])})`)}`);
    }

    /* 5. Telegram bot token — validated against getMe, which also names the bot. */
    if (willRun(plan, 'telegram-token')) {
      console.log(bold('\nTelegram bot'));
      console.log(
        'Talk to @BotFather in Telegram, `/newbot`, and paste the token it gives you.\n' +
          'Leave it empty to skip — the terminal surface works without it.',
      );
      const token = (await ask('TELEGRAM_BOT_TOKEN: ')).trim();
      if (token !== '') {
        const me = await verifyBot(token);
        if (me) {
          remember('TELEGRAM_BOT_TOKEN', token);
          console.log(`  bot @${me.username ?? me.id} (id ${me.id}) — token accepted`);
        } else {
          console.log(dim('  Telegram rejected that token; skipping. Re-run `buddi init` to retry.'));
        }
      }
    } else if (stepOf(plan, 'telegram-token').action === 'done') {
      const me = await verifyBot(known.TELEGRAM_BOT_TOKEN as string);
      const where = sourceOf(secrets.sources.TELEGRAM_BOT_TOKEN);
      console.log(
        me
          ? `\nTelegram bot: @${me.username ?? me.id} ${dim(`(token ${where})`)}`
          : `\nTelegram bot: token set but Telegram rejected it ${dim(`(${where}; \`buddi vault set TELEGRAM_BOT_TOKEN\` to replace it)`)}`,
      );
    }

    /* 6. Timezone — the day every agent means by "today". */
    if (willRun(plan, 'timezone')) {
      const guess = detectedTimezone();
      const answer = (await ask(`\nTimezone [${guess}]: `)).trim();
      const tz = answer === '' ? guess : answer;
      if (!validTimezone(tz)) {
        console.log(dim(`  ${tz} is not an IANA zone; keeping the default.`));
      } else {
        remember('BUDDI_TZ', tz);
        console.log(`  BUDDI_TZ=${tz}`);
      }
    } else if (stepOf(plan, 'timezone').action === 'done') {
      console.log(`\nTimezone: ${env.BUDDI_TZ} ${dim('(unchanged)')}`);
    }

    /* 7. Who the owner is, for the agent to use by name. */
    if (willRun(plan, 'owner-name')) {
      const name = (await ask('\nWhat should the agents call you? ')).trim();
      if (name !== '') {
        remember('BUDDI_OWNER_NAME', name);
        console.log(`  BUDDI_OWNER_NAME=${name}`);
      }
    } else if (stepOf(plan, 'owner-name').action === 'done') {
      console.log(`\nOwner: ${env.BUDDI_OWNER_NAME} ${dim('(unchanged)')}`);
    }

    /* 8. Where the owner's own agents and skills live. */
    if (willRun(plan, 'private-config')) {
      await setUpPrivateConfig(ask, { ...env, ...known }, remember, { interactive });
    } else {
      console.log(`\nPrivate configuration: ${dim(stepOf(plan, 'private-config').reason ?? '')}`);
    }

    if (edits.length > 0) {
      text = applyEnvEdits(text, edits);
      writeFileSync(ENV_FILE, text, { mode: 0o600 });
      console.log(dim(`\nwrote ${edits.length} value(s) to ${ENV_FILE} (mode 600)`));
      env = parseEnv(text);
    }

    /* 9. Bring the machine up. */
    if (willRun(plan, 'database')) {
      console.log(bold('\nStarting postgres (docker compose up -d postgres)…'));
      const code = await runInherit('pnpm', ['db:up'], { cwd: REPO_ROOT });
      if (code !== 0) {
        console.error('`pnpm db:up` failed. Is Docker running? Fix it and re-run `buddi init`.');
        return 1;
      }
      await waitForPostgres(databaseUrl);
    } else {
      console.log(dim('\nSkipping `pnpm db:up` — no docker. DATABASE_URL must point somewhere real.'));
    }

    console.log(bold('\nBuilding (pnpm -r build)…'));
    if ((await runInherit('pnpm', ['-r', 'build'], { cwd: REPO_ROOT })) !== 0) {
      console.error('the build failed — fix it and re-run `buddi init`');
      return 1;
    }

    console.log(bold('\nMigrating…'));
    if ((await runInherit('pnpm', ['db:migrate'], { cwd: REPO_ROOT })) !== 0) {
      console.error('migrations failed — `buddi doctor` will say more');
      return 1;
    }

    /*
     * 10. The tail. The database was down when the plan was first made, so the
     *     three steps that depend on it are re-planned now that it is up — a
     *     machine that is already paired must not be asked to pair again.
     */
    plan = planInit(await facts());

    /* 10a. Pair a device, right here, by QR. */
    if (willRun(plan, 'telegram-pair')) {
      const paired = await pairHere(confirm, { ...env, DATABASE_URL: databaseUrl }, {
        onNeedsService: () => ensureService(confirm),
      });
      if (paired) plan = planInit(await facts());
    } else if (stepOf(plan, 'telegram-pair').action === 'done') {
      console.log(`\nTelegram: ${dim(stepOf(plan, 'telegram-pair').reason ?? '')}`);
    }

    /* 10b. The background service. */
    if (willRun(plan, 'service')) await ensureService(confirm);

    /* 10c. The dashboard. */
    if (willRun(plan, 'dashboard')) {
      if (await confirm('\nOpen the local dashboard now?', true)) {
        const open = opts.openDashboard ?? (() => runDashboard('open'));
        await open();
      }
    }

    /*
     * 10d. The first conversation. Not configuration: the wizard has finished
     *      asking things, and the last thing it does is get out of the way so
     *      the agent can ask the two or three things it actually needs — in its
     *      own words, in a chat, rather than as three more prompts here.
     */
    plan = planInit(await facts());
    const interview = await offerFirstRun(confirm, stepOf(plan, 'first-run'));

    console.log();
    for (const line of nextSteps(planInit(await facts()))) console.log(line);

    if (interview) {
      // readline owns stdin; hand it over before `buddi chat` wants it.
      rl?.close();
      console.log();
      await runInherit(process.execPath, [CLI_ENTRY, 'chat'], { cwd: REPO_ROOT });
    }
    return 0;
  } finally {
    rl?.close();
  }
}

/** This process's own entry point — what `buddi chat` is, from inside init. */
const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'main.js');

/**
 * Has this installation ever had its first conversation?
 *
 * Best effort in the honest sense: a database that is not up, or one migrated
 * before 013 landed, answers "no" — the wizard then says nothing about it
 * rather than failing a run that otherwise succeeded.
 */
export async function onboardingIsPending(databaseUrl: string | undefined): Promise<boolean> {
  if (!databaseUrl) return false;
  const pool = createPool(databaseUrl);
  try {
    return (await getOnboarding(pool)).state === 'pending';
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * The wizard's last step: point the owner at the conversation, or offer to have
 * it here. Returns whether `buddi chat` should be started on the way out.
 *
 * With a paired device there is nothing to offer — the agent opens the
 * conversation itself the moment the owner opens the chat — so this is one
 * line, not a question.
 */
export async function offerFirstRun(
  confirm: (question: string, byDefault?: boolean) => Promise<boolean>,
  step: PlannedStep,
): Promise<boolean> {
  if (step.action === 'done' || step.action === 'skipped') return false;
  console.log(bold('\nMeet your agent'));
  if (step.action === 'run') {
    console.log(
      '  Open your paired Telegram chat and say hello — the agent introduces itself\n' +
        '  there and asks the few things it needs.',
    );
    return false;
  }
  if (!(await confirm('Have that conversation here now? It takes a minute.', true))) {
    console.log(dim('  skipped — `buddi chat` and it will introduce itself'));
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * The steps that need more than a question
 * ------------------------------------------------------------------ */

/**
 * Install (and start) the background service, with the owner's consent.
 *
 * Returns whether a service is now installed. Never throws: a launchd that
 * refuses is a line to read, not a failed installation — everything else the
 * wizard did still stands.
 */
export async function ensureService(
  confirm: (question: string, byDefault?: boolean) => Promise<boolean>,
): Promise<boolean> {
  const manager = createServiceManager();
  try {
    const status = await manager.status();
    if (status.installed) {
      console.log(`\nBackground service: ${dim(status.detail)}`);
      return true;
    }
  } catch {
    /* fall through and offer it anyway */
  }
  if (!(await confirm('\nRun the surfaces and scheduler in the background, starting at login?', true))) {
    console.log(dim('  skipped — `buddi service install` when you want it'));
    return false;
  }
  try {
    for (const note of await manager.install()) console.log(`  ${note}`);
    return true;
  } catch (err) {
    console.log(dim(`  could not install the service: ${message(err)}`));
    console.log(dim('  run `buddi service install` to see the whole error'));
    return false;
  }
}

/**
 * Pair a device without leaving the wizard: mint a code, draw the QR, and then
 * watch the database until a device appears or `PAIR_WAIT_MS` runs out.
 *
 * Polling is the honest mechanism here. The device pairs by talking to the bot,
 * which is a different process; the only thing this one can observe is the row
 * that process writes.
 */
export async function pairHere(
  confirm: (question: string, byDefault?: boolean) => Promise<boolean>,
  env: Record<string, string | undefined>,
  hooks: {
    onNeedsService?: () => Promise<boolean>;
    /** Injected in tests; the real one sleeps. */
    wait?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return false;

  console.log(bold('\nPair a device'));
  if (!(await confirm('Pair your phone now? It takes about thirty seconds.', true))) {
    console.log(dim('  skipped — `buddi telegram pair` when you want it'));
    return false;
  }

  // Nothing receives the code unless a poller is running: the surface claims it,
  // not this process. Offer to put one there before printing something with a
  // ten-minute life.
  if (hooks.onNeedsService) {
    const running = await hooks.onNeedsService();
    if (!running) {
      console.log(
        dim('  no service is installed, so nothing is listening for the code — pair later with `buddi telegram pair`.'),
      );
      return false;
    }
  }

  const pool = createPool(databaseUrl);
  try {
    const before = (await listDevices(pool)).length;
    const { code, deepLink, expiresAt } = await createPairingCode(pool, { env });
    console.log(await renderQr(deepLink));
    console.log(bold('  Scan it, or open this link on the device:'));
    console.log(`  ${deepLink}`);
    console.log(`  code ${bold(code)}`);
    console.log(dim(`  valid until ${expiresAt.toISOString()} — anyone holding it can pair.`));
    console.log(dim(`  waiting up to ${Math.round(PAIR_WAIT_MS / 1000)}s… (Ctrl-C to skip)`));

    const wait = hooks.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = hooks.now ?? (() => Date.now());
    const deadline = now() + PAIR_WAIT_MS;
    while (now() < deadline) {
      await wait(PAIR_POLL_MS);
      const devices = await listDevices(pool);
      if (devices.length > before) {
        const device = devices[devices.length - 1];
        console.log(`  paired: ${device?.label ?? device?.externalUserId ?? 'a device'}`);
        return true;
      }
    }
    console.log(dim('  nothing paired yet — the code stays valid; run `buddi telegram pair` to mint another.'));
    return false;
  } catch (err) {
    console.log(dim(`  pairing could not start: ${message(err)}`));
    return false;
  } finally {
    await pool.end();
  }
}

/**
 * Make sure this installation has a database password of its own, and hand back
 * the connection string everything else in the wizard should use.
 *
 * Returns whatever `resolveDatabaseUrl` settles on, so an owner who pointed
 * `DATABASE_URL` at their own Postgres gets exactly that back and nothing is
 * generated, stored or rewritten.
 */
export async function setUpDatabasePassword(
  vault: Vault | undefined,
  env: Record<string, string | undefined>,
  io: { log?: (line: string) => void } = {},
): Promise<string | undefined> {
  const log = io.log ?? ((line: string) => console.log(line));
  const ensured = await ensureDatabasePassword({ env: env as NodeJS.ProcessEnv, vault });
  if (ensured === null) {
    const resolution = await resolveDatabaseUrl({ env: env as NodeJS.ProcessEnv, vault });
    log(`\nDatabase: ${dim('DATABASE_URL is set explicitly — buddi will not touch it')}`);
    // Compose still needs *something*; the explicit URL's own password is not
    // ours to hand it, so nothing is exported and compose keeps its default.
    return resolution.url;
  }

  // The compose file reads this out of the environment. It is deliberately not
  // written to `.env`: a password in a file is the thing being fixed.
  process.env[DB_PASSWORD_VAR] = ensured.password;
  const url = assembleDatabaseUrl({ ...databaseDefaults(env as NodeJS.ProcessEnv), password: ensured.password });
  process.env[DATABASE_URL_VAR] = url;

  log(
    ensured.created
      ? `\nDatabase password: ${bold('generated')} ${dim(`(${shape(ensured.password)}, stored as ${DB_PASSWORD_VAR} in the vault — never in .env)`)}`
      : `\nDatabase password: ${dim(`already in the vault as ${DB_PASSWORD_VAR}`)}`,
  );
  return url;
}

/** This machine's IANA zone, with a defined fallback. */
export function detectedTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
}

/** Does the owner's private agents directory already hold an agent? */
export function hasPrivateAgents(env: Record<string, string | undefined>): boolean {
  const pinned = (env.BUDDI_AGENTS_DIR ?? '').trim();
  const dir = pinned !== '' ? pinned : path.join(DEFAULT_PRIVATE_DIR, 'agents');
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((name) => !name.startsWith('.'));
  } catch {
    return false;
  }
}

/** Best effort: a database that is not up yet simply has no paired devices. */
async function countPairedDevices(databaseUrl: string | undefined): Promise<number> {
  if (!databaseUrl) return 0;
  const pool = createPool(databaseUrl);
  try {
    return (await listDevices(pool)).length;
  } catch {
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

/** Best effort: a platform with no service manager is simply not installed. */
async function serviceIsInstalled(): Promise<boolean> {
  try {
    return (await createServiceManager().status()).installed;
  } catch {
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ------------------------------------------------------------------ *
 * Private configuration
 * ------------------------------------------------------------------ */

/** The default home for the owner's agents and skills: `<repo>/private`. */
export const DEFAULT_PRIVATE_DIR = path.join(REPO_ROOT, 'private');

/** The example agent this repository ships — the starting point for a copy. */
export const EXAMPLE_AGENTS_DIR = path.join(REPO_ROOT, 'examples', 'agents');

export const PRIVATE_README = `# Your private configuration

Everything in this directory is **yours**, not the platform's.

- \`agents/<id>/agent.md\` — one folder per agent: frontmatter wires it (handle,
  tools, model, turn budget), the markdown body is its persona.
- \`skills/*.md\` — procedures composed into your agents' prompts.

Two things to know:

1. **It is never committed.** \`private/\` is in \`.gitignore\`. Your personas name
   your bank, your landlord, your inbox; they do not belong in a repository you
   might share or push.
2. **It overrides the examples.** buddi loads \`examples/agents\` first and then
   this directory. An agent here with the same id as an example one *replaces*
   it wholesale — so to change an example, copy it here and edit the copy. The
   same holds for a skill, by name.

Add an agent by adding a folder, then restart the service:

    buddi agents           # what loaded, and where each one came from
    buddi service restart  # the running surfaces reload the catalog

To share a persona with someone, hand them the folder. It is a file.
`;

/**
 * Create the private directory and explain what it is for.
 *
 * Idempotent: a directory that already holds agents is left completely alone.
 * An empty one gets the example agent copied in, because the first question
 * after "where does my configuration live" is always "what does one look like".
 */
export async function setUpPrivateConfig(
  ask: (question: string) => Promise<string>,
  known: Record<string, string>,
  remember: (key: string, value: string) => void,
  io: { log?: (line: string) => void; interactive?: boolean } = {},
): Promise<string> {
  const log = io.log ?? ((line: string) => console.log(line));
  // With nobody to ask, the default location *is* the answer: a script still
  // gets a private directory with the example agent in it.
  const interactive = io.interactive ?? true;
  const pinned = known.BUDDI_AGENTS_DIR;
  let root = DEFAULT_PRIVATE_DIR;

  if (pinned !== undefined && pinned.trim() !== '') {
    root = path.dirname(pinned.trim());
    log(`\nPrivate configuration: ${root} ${dim('(BUDDI_AGENTS_DIR)')}`);
  } else if (existsSync(path.join(root, 'agents'))) {
    log(`\nPrivate configuration: ${root} ${dim('(unchanged)')}`);
  } else {
    log(bold('\nYour agents and skills'));
    log(
      'The agents in this repository are examples. Yours live in a private directory\n' +
        'that is never committed — personas name real accounts, inboxes and people.',
    );
    const answer = interactive ? (await ask(`Where should they live? [${root}] `)).trim() : '';
    if (answer !== '') {
      root = path.resolve(answer);
      if (root !== DEFAULT_PRIVATE_DIR) remember('BUDDI_AGENTS_DIR', path.join(root, 'agents'));
    }
  }

  const agentsDir = path.join(root, 'agents');
  const skillsDir = path.join(root, 'skills');
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  const readme = path.join(root, 'README.md');
  if (!existsSync(readme)) writeFileSync(readme, PRIVATE_README);

  const empty = readdirSync(agentsDir).filter((name) => !name.startsWith('.')).length === 0;
  if (empty && existsSync(EXAMPLE_AGENTS_DIR)) {
    for (const name of readdirSync(EXAMPLE_AGENTS_DIR)) {
      cpSync(path.join(EXAMPLE_AGENTS_DIR, name), path.join(agentsDir, name), { recursive: true });
    }
    log(dim(`  copied the example agent into ${agentsDir} as a starting point`));
  }
  log(dim(`  ${root} — yours, gitignored, and it overrides the examples`));
  return root;
}

/** Where a resolved secret came from, for a line the owner reads. Never a value. */
function sourceOf(source: 'vault' | 'env' | undefined): string {
  return source === 'vault' ? 'from the vault' : 'unchanged';
}

async function verifyBot(token: string): Promise<{ id: number; username?: string } | null> {
  try {
    const me = await new TelegramApi({ token }).getMe();
    return { id: me.id, ...(me.username ? { username: me.username } : {}) };
  } catch {
    return null;
  }
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The container answers a few seconds after `up`; poll rather than guess. */
async function waitForPostgres(databaseUrl: string | undefined): Promise<void> {
  if (!databaseUrl) return;
  for (let i = 0; i < 20; i++) {
    const res = await run('docker', ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'buddi'], {
      cwd: REPO_ROOT,
      timeoutMs: 10_000,
    });
    if (res.code === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(dim('postgres did not report ready in 20s — continuing anyway'));
}
