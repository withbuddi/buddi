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
  KNOWN_SECRETS,
  createVault,
  resolveSecrets,
  type Vault,
} from '@buddi/core';
import { TelegramApi } from '@buddi/gateway';
import { applyEnvEdits, isBlank, maskSecret, parseEnv, type EnvEdit } from './env-file.js';
import { ENV_EXAMPLE_FILE, ENV_FILE, REPO_ROOT } from './paths.js';
import { run, runInherit, versionOf } from './proc.js';

const ESC = '\u001b[';
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}0m`;

const MIN_NODE_MAJOR = 22;

export interface InitOptions {
  /** Injected in tests; defaults to a real readline over stdin/stdout. */
  ask?: (question: string) => Promise<string>;
  /** Injected in tests; defaults to this machine's vault. */
  vault?: Vault | undefined;
}

export async function runInit(opts: InitOptions = {}): Promise<number> {
  const rl = opts.ask
    ? undefined
    : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = opts.ask ?? ((q: string) => rl!.question(q));

  try {
    console.log(bold('buddi init'));
    console.log(dim(`installation: ${REPO_ROOT}`));
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
    if (!existsSync(ENV_FILE)) {
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

    /* 3. Model credential. */
    if (isBlank(known, 'CLAUDE_CODE_OAUTH_TOKEN') && isBlank(known, 'ANTHROPIC_API_KEY')) {
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
    } else {
      const kind = !isBlank(known, 'CLAUDE_CODE_OAUTH_TOKEN')
        ? 'CLAUDE_CODE_OAUTH_TOKEN'
        : 'ANTHROPIC_API_KEY';
      console.log(`\nModel credential: ${kind} already set ${dim(`(${sourceOf(secrets.sources[kind])})`)}`);
    }

    /* 4. Telegram bot token — validated against getMe, which also names the bot. */
    if (isBlank(known, 'TELEGRAM_BOT_TOKEN')) {
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
    } else {
      const me = await verifyBot(known.TELEGRAM_BOT_TOKEN as string);
      const where = sourceOf(secrets.sources.TELEGRAM_BOT_TOKEN);
      console.log(
        me
          ? `\nTelegram bot: @${me.username ?? me.id} ${dim(`(token ${where})`)}`
          : `\nTelegram bot: token set but Telegram rejected it ${dim(`(${where}; \`buddi vault set TELEGRAM_BOT_TOKEN\` to replace it)`)}`,
      );
    }

    /* 5. Timezone — the day every agent means by "today". */
    if (isBlank(env, 'BUDDI_TZ')) {
      const guess = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
      const answer = (await ask(`\nTimezone [${guess}]: `)).trim();
      const tz = answer === '' ? guess : answer;
      if (!validTimezone(tz)) {
        console.log(dim(`  ${tz} is not an IANA zone; keeping the default.`));
      } else {
        remember('BUDDI_TZ', tz);
        console.log(`  BUDDI_TZ=${tz}`);
      }
    } else {
      console.log(`\nTimezone: ${env.BUDDI_TZ} ${dim('(unchanged)')}`);
    }

    /* 6. Who the owner is, for the agent to use by name. */
    if (isBlank(env, 'BUDDI_OWNER_NAME')) {
      const name = (await ask('\nWhat should the agents call you? ')).trim();
      if (name !== '') {
        remember('BUDDI_OWNER_NAME', name);
        console.log(`  BUDDI_OWNER_NAME=${name}`);
      }
    } else {
      console.log(`\nOwner: ${env.BUDDI_OWNER_NAME} ${dim('(unchanged)')}`);
    }

    /* 7. Where the owner's own agents and skills live. */
    await setUpPrivateConfig(ask, { ...env, ...known }, remember);

    if (edits.length > 0) {
      text = applyEnvEdits(text, edits);
      writeFileSync(ENV_FILE, text, { mode: 0o600 });
      console.log(dim(`\nwrote ${edits.length} value(s) to ${ENV_FILE} (mode 600)`));
      env = parseEnv(text);
    }

    /* 8. Bring the machine up. */
    if (dockerVersion) {
      console.log(bold('\nStarting postgres (docker compose up -d postgres)…'));
      const code = await runInherit('pnpm', ['db:up'], { cwd: REPO_ROOT });
      if (code !== 0) {
        console.error('`pnpm db:up` failed. Is Docker running? Fix it and re-run `buddi init`.');
        return 1;
      }
      await waitForPostgres(env.DATABASE_URL);
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

    console.log(bold('\nbuddi is set up.'));
    console.log('  Next:  buddi service install   — run the surface + scheduler in the background');
    console.log('         buddi telegram pair     — pair your phone');
    console.log('  Then:  buddi doctor            — confirm everything at once');
    return 0;
  } finally {
    rl?.close();
  }
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
  io: { log?: (line: string) => void } = {},
): Promise<string> {
  const log = io.log ?? ((line: string) => console.log(line));
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
    const answer = (await ask(`Where should they live? [${root}] `)).trim();
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
