/**
 * What `buddi init` is going to do, decided before it does any of it.
 *
 * The wizard has two halves: a *plan* (this file — pure, total, testable with a
 * plain object) and the execution of it (`init.ts`, which talks to docker, the
 * vault, Telegram and launchd). Keeping the decisions here is what makes the
 * three properties the wizard promises checkable:
 *
 *  - **idempotent** — every step that is already done is planned as `done`, so a
 *    second run on a finished machine asks nothing and changes nothing;
 *  - **skippable** — every step carries whether it needs the owner, so declining
 *    one never blocks the next;
 *  - **non-interactive** — with `--yes`, or with no TTY, anything that needs a
 *    human is planned as `skipped` with the reason, and the rest still runs.
 *
 * Nothing here reads a file, an environment variable or a clock: `planInit`
 * takes facts and returns rows.
 */

/** Every step of the wizard, in the order it is executed. */
export const STEP_IDS = [
  'env-file',
  'model-credential',
  'telegram-token',
  'timezone',
  'owner-name',
  'private-config',
  'database',
  'build',
  'migrate',
  'telegram-pair',
  'service',
  'dashboard',
] as const;

export type StepId = (typeof STEP_IDS)[number];

/**
 * What the wizard will do with a step.
 *
 * `ask` and `run` both execute; the difference is whether the owner is put in
 * front of a question first. `done` and `skipped` both execute nothing — they
 * are separated because "already true" and "cannot be done here" are different
 * things to read at the end of a run.
 */
export type StepAction = 'ask' | 'run' | 'done' | 'skipped';

export interface PlannedStep {
  id: StepId;
  /** One line, as the owner reads it in the plan. */
  title: string;
  action: StepAction;
  /** Why it is `done` or `skipped`. Absent for `ask` and `run`. */
  reason?: string;
}

/**
 * What the wizard needs to know about this machine to decide. Every field is a
 * fact someone else established — `init.ts` gathers them, this file judges them.
 */
export interface InitFacts {
  /** A TTY on both ends and no `--yes`: the owner can be asked things. */
  interactive: boolean;
  /** `--yes`. Consent given up front for anything that only needs a yes. */
  assumeYes: boolean;
  envFileExists: boolean;
  hasModelCredential: boolean;
  hasBotToken: boolean;
  hasTimezone: boolean;
  hasOwnerName: boolean;
  /** The owner's private agents directory exists and holds at least one agent. */
  hasPrivateAgents: boolean;
  hasDocker: boolean;
  /** How many devices are already paired. Non-zero means pairing is done. */
  pairedDevices: number;
  serviceInstalled: boolean;
  /** `BUDDI_WEB` is not `0`. */
  dashboardEnabled: boolean;
}

const NO_TTY = 'non-interactive';

/**
 * A step that needs the owner to *type* something — a token, a name, a zone.
 * Already true is `done`; otherwise there is no answer to invent, so a
 * non-interactive run skips it rather than guessing.
 */
function typed(already: boolean, interactive: boolean): StepAction {
  if (already) return 'done';
  return interactive ? 'ask' : 'skipped';
}

/**
 * Plan a run. Total: it always returns exactly one row per step in `STEP_IDS`,
 * whatever the facts say, so the caller can drive the wizard off the plan
 * rather than off a second copy of these conditions.
 */
export function planInit(facts: InitFacts): PlannedStep[] {
  const { interactive } = facts;
  const steps: PlannedStep[] = [];

  const step = (id: StepId, title: string, action: StepAction, reason?: string): void => {
    steps.push(reason === undefined ? { id, title, action } : { id, title, action, reason });
  };

  step(
    'env-file',
    'create .env from .env.example',
    facts.envFileExists ? 'done' : 'run',
    facts.envFileExists ? '.env already exists' : undefined,
  );

  step(
    'model-credential',
    'a model credential (subscription token or API key)',
    typed(facts.hasModelCredential, interactive),
    facts.hasModelCredential
      ? 'already set'
      : interactive
        ? undefined
        : `${NO_TTY} — set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env`,
  );

  step(
    'telegram-token',
    'a Telegram bot token (optional)',
    typed(facts.hasBotToken, interactive),
    facts.hasBotToken
      ? 'already set'
      : interactive
        ? undefined
        : `${NO_TTY} — set TELEGRAM_BOT_TOKEN in .env`,
  );

  step(
    'timezone',
    'the timezone every agent means by "today"',
    typed(facts.hasTimezone, interactive),
    facts.hasTimezone ? 'already set' : interactive ? undefined : `${NO_TTY} — set BUDDI_TZ in .env`,
  );

  step(
    'owner-name',
    'what the agents should call you',
    typed(facts.hasOwnerName, interactive),
    facts.hasOwnerName
      ? 'already set'
      : interactive
        ? undefined
        : `${NO_TTY} — set BUDDI_OWNER_NAME in .env`,
  );

  // The one "asks a question" step with a usable default: a non-interactive run
  // still creates `private/` and copies the example agent in, because there is
  // nothing to invent — the default location is the answer.
  step(
    'private-config',
    'your private agents directory, seeded with the example agent',
    facts.hasPrivateAgents ? 'done' : interactive ? 'ask' : 'run',
    facts.hasPrivateAgents ? 'already has agents' : undefined,
  );

  step(
    'database',
    'start the postgres container',
    facts.hasDocker ? 'run' : 'skipped',
    facts.hasDocker ? undefined : 'no docker — DATABASE_URL must point at a real postgres',
  );

  step('build', 'build the workspace', 'run');
  step('migrate', 'apply core + plugin migrations', 'run');

  // Pairing needs a device in the owner's hand and a poller running. Neither is
  // available to a script, and `already paired` is the common second-run case.
  step(
    'telegram-pair',
    'pair a device by QR code',
    !facts.hasBotToken
      ? 'skipped'
      : facts.pairedDevices > 0
        ? 'done'
        : interactive
          ? 'ask'
          : 'skipped',
    !facts.hasBotToken
      ? 'no bot token'
      : facts.pairedDevices > 0
        ? `${facts.pairedDevices} device(s) already paired`
        : interactive
          ? undefined
          : `${NO_TTY} — run \`buddi telegram pair\` from a terminal`,
  );

  // Installing the service needs no typing, only consent — so `--yes` is enough.
  step(
    'service',
    'run the surfaces + scheduler in the background, at login',
    facts.serviceInstalled ? 'done' : interactive ? 'ask' : facts.assumeYes ? 'run' : 'skipped',
    facts.serviceInstalled
      ? 'already installed'
      : interactive || facts.assumeYes
        ? undefined
        : `${NO_TTY} — run \`buddi service install\``,
  );

  // Opening a browser is never something a script wants done to it.
  step(
    'dashboard',
    'open the local dashboard',
    !facts.dashboardEnabled ? 'skipped' : interactive ? 'ask' : 'skipped',
    !facts.dashboardEnabled
      ? 'BUDDI_WEB=0'
      : interactive
        ? undefined
        : `${NO_TTY} — run \`buddi dashboard\``,
  );

  return steps;
}

/** The step, by id. The plan is total, so this never returns undefined. */
export function stepOf(plan: readonly PlannedStep[], id: StepId): PlannedStep {
  return plan.find((s) => s.id === id) as PlannedStep;
}

/** True when the wizard should execute this step at all. */
export function willRun(plan: readonly PlannedStep[], id: StepId): boolean {
  const action = stepOf(plan, id).action;
  return action === 'ask' || action === 'run';
}

/** Nothing left to do: a finished machine, re-run. */
export function isNoop(plan: readonly PlannedStep[]): boolean {
  return plan.every((s) => s.action === 'done' || s.action === 'skipped');
}

/** The plan as the owner reads it before anything happens. */
export function renderPlan(plan: readonly PlannedStep[]): string {
  const mark: Record<StepAction, string> = {
    ask: ' • ',
    run: ' • ',
    done: ' ✓ ',
    skipped: ' – ',
  };
  return plan
    .map((s) => `${mark[s.action]}${s.title}${s.reason ? `  (${s.reason})` : ''}`)
    .join('\n');
}

/**
 * The three sentences a brand-new installation should send first.
 *
 * Concrete on purpose: "try asking it something" is advice nobody acts on, and
 * each of these exercises a different half of what the example agent can do.
 */
export const FIRST_MESSAGES = [
  'What is buddi, and what can you actually do for me?',
  'Remember that I am usually at my desk between 9 and 6 on weekdays.',
  'Remind me in 30 minutes to finish setting this up.',
] as const;

/** The closing block: where to go next, and what to say when you get there. */
export function nextSteps(plan: readonly PlannedStep[]): string[] {
  const lines: string[] = ['buddi is set up.', ''];

  const pair = stepOf(plan, 'telegram-pair');
  const service = stepOf(plan, 'service');
  const todo: string[] = [];
  if (service.action === 'skipped') todo.push('buddi service install   — run it in the background');
  if (pair.action === 'skipped' && stepOf(plan, 'telegram-token').action !== 'skipped') {
    todo.push('buddi telegram pair     — pair your phone');
  }
  todo.push('buddi doctor            — confirm every moving part at once');
  lines.push('Still to do:', ...todo.map((t) => `  ${t}`), '');

  lines.push(
    'Then open `buddi chat` (or your paired Telegram chat) and send one of these:',
    ...FIRST_MESSAGES.map((m) => `  "${m}"`),
    '',
    'Your agents live in your private directory and are never committed.',
    'Add one, then `buddi service restart` so the running surfaces reload the catalog.',
  );
  return lines;
}
