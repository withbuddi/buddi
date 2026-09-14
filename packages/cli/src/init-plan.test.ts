/**
 * The wizard's decisions, against a fake machine.
 *
 * Three properties are asserted here rather than described in a README: every
 * step is skippable, a second run on a finished machine does nothing, and a run
 * with nobody at the keyboard still gets as far as it can.
 */
import { describe, expect, it } from 'vitest';
import {
  FIRST_MESSAGES,
  isNoop,
  nextSteps,
  planInit,
  renderPlan,
  STEP_IDS,
  stepOf,
  willRun,
  type InitFacts,
} from './init-plan.js';

/** A machine with nothing done yet, sitting in front of an owner. */
const FRESH: InitFacts = {
  interactive: true,
  assumeYes: false,
  envFileExists: false,
  hasModelCredential: false,
  hasBotToken: false,
  hasTimezone: false,
  hasOwnerName: false,
  hasPrivateAgents: false,
  hasDocker: true,
  pairedDevices: 0,
  serviceInstalled: false,
  dashboardEnabled: true,
  onboardingPending: true,
};

/** The same machine after a successful run. */
const FINISHED: InitFacts = {
  ...FRESH,
  envFileExists: true,
  hasModelCredential: true,
  hasBotToken: true,
  hasTimezone: true,
  hasOwnerName: true,
  hasPrivateAgents: true,
  pairedDevices: 1,
  serviceInstalled: true,
  onboardingPending: false,
};

describe('the first run', () => {
  it('is a question on a machine with no paired device', () => {
    expect(stepOf(planInit(FRESH), 'first-run').action).toBe('ask');
  });

  it('is only a line to read when a device is paired: the agent opens it there', () => {
    const plan = planInit({ ...FRESH, pairedDevices: 1 });
    expect(stepOf(plan, 'first-run').action).toBe('run');
  });

  it('is done on a machine that has already had the conversation', () => {
    const step = stepOf(planInit(FINISHED), 'first-run');
    expect(step.action).toBe('done');
    expect(step.reason).toBe('already done');
  });

  it('is skipped with nobody at the keyboard, and names what to run', () => {
    const step = stepOf(planInit({ ...FRESH, interactive: false }), 'first-run');
    expect(step.action).toBe('skipped');
    expect(step.reason).toContain('buddi chat');
  });

  it('is the last thing the wizard does', () => {
    expect(STEP_IDS[STEP_IDS.length - 1]).toBe('first-run');
  });
});

describe('planInit', () => {
  it('returns exactly one row per step, in order, whatever the facts', () => {
    for (const facts of [FRESH, FINISHED, { ...FRESH, interactive: false }]) {
      expect(planInit(facts).map((s) => s.id)).toEqual([...STEP_IDS]);
    }
  });

  it('asks about everything on a fresh interactive machine', () => {
    const plan = planInit(FRESH);
    expect(stepOf(plan, 'model-credential').action).toBe('ask');
    expect(stepOf(plan, 'timezone').action).toBe('ask');
    expect(stepOf(plan, 'owner-name').action).toBe('ask');
    expect(stepOf(plan, 'private-config').action).toBe('ask');
    expect(stepOf(plan, 'service').action).toBe('ask');
    expect(stepOf(plan, 'dashboard').action).toBe('ask');
    expect(isNoop(plan)).toBe(false);
  });

  it('gives every step a reason when it is not going to do it', () => {
    for (const step of planInit({ ...FINISHED, hasDocker: false, dashboardEnabled: false })) {
      if (step.action === 'done' || step.action === 'skipped') {
        expect(step.reason, `${step.id} was skipped without saying why`).toBeTruthy();
      }
    }
  });
});

describe('idempotence', () => {
  it('re-runs only the idempotent bring-up on a finished machine', () => {
    const plan = planInit(FINISHED);
    const doing = plan.filter((s) => willRun(plan, s.id)).map((s) => s.id);
    // Nothing is configured a second time. `database`, `build` and `migrate`
    // are re-run because each is a no-op when it is already true, and the
    // dashboard is still offered — it is one keypress and opens a browser tab.
    expect(doing).toEqual(['database', 'build', 'migrate', 'dashboard']);
  });

  it('marks a step already done as done, not as skipped', () => {
    const plan = planInit(FINISHED);
    expect(stepOf(plan, 'model-credential').action).toBe('done');
    expect(stepOf(plan, 'telegram-pair').action).toBe('done');
    expect(stepOf(plan, 'telegram-pair').reason).toContain('1 device');
    expect(stepOf(plan, 'service').action).toBe('done');
  });

  it('is stable: planning twice from the same facts gives the same plan', () => {
    expect(planInit(FINISHED)).toEqual(planInit(FINISHED));
  });
});

describe('every step is skippable', () => {
  it('never blocks a later step when an earlier one is not done', () => {
    // No credential, no bot token, no docker: the wizard still plans the build,
    // the migration and the private directory.
    const plan = planInit({ ...FRESH, hasDocker: false });
    expect(stepOf(plan, 'database').action).toBe('skipped');
    expect(willRun(plan, 'build')).toBe(true);
    expect(willRun(plan, 'migrate')).toBe(true);
    expect(willRun(plan, 'private-config')).toBe(true);
  });

  it('skips pairing when there is no bot token, without failing anything else', () => {
    const plan = planInit({ ...FRESH, hasBotToken: false });
    expect(stepOf(plan, 'telegram-pair').action).toBe('skipped');
    expect(stepOf(plan, 'telegram-pair').reason).toBe('no bot token');
    expect(willRun(plan, 'service')).toBe(true);
  });

  it('skips the dashboard when it is turned off', () => {
    const plan = planInit({ ...FRESH, dashboardEnabled: false });
    expect(stepOf(plan, 'dashboard')).toMatchObject({ action: 'skipped', reason: 'BUDDI_WEB=0' });
  });
});

describe('non-interactive', () => {
  const HEADLESS: InitFacts = { ...FRESH, interactive: false };

  it('skips every step that needs something typed, and says why', () => {
    const plan = planInit(HEADLESS);
    for (const id of ['model-credential', 'telegram-token', 'timezone', 'owner-name'] as const) {
      expect(stepOf(plan, id).action, id).toBe('skipped');
      expect(stepOf(plan, id).reason, id).toContain('non-interactive');
    }
  });

  it('still does everything that needs no owner', () => {
    const plan = planInit(HEADLESS);
    expect(willRun(plan, 'env-file')).toBe(true);
    expect(willRun(plan, 'private-config')).toBe(true);
    expect(willRun(plan, 'database')).toBe(true);
    expect(willRun(plan, 'build')).toBe(true);
    expect(willRun(plan, 'migrate')).toBe(true);
  });

  it('never pairs a device or opens a browser', () => {
    for (const assumeYes of [false, true]) {
      const plan = planInit({ ...HEADLESS, assumeYes, hasBotToken: true });
      expect(stepOf(plan, 'telegram-pair').action).toBe('skipped');
      expect(stepOf(plan, 'dashboard').action).toBe('skipped');
    }
  });

  it('installs the service only when --yes gave consent up front', () => {
    expect(stepOf(planInit(HEADLESS), 'service').action).toBe('skipped');
    expect(stepOf(planInit({ ...HEADLESS, assumeYes: true }), 'service').action).toBe('run');
  });

  it('is idempotent too: a finished machine plans only the idempotent bring-up', () => {
    const plan = planInit({ ...FINISHED, interactive: false, assumeYes: true });
    expect(plan.filter((s) => willRun(plan, s.id)).map((s) => s.id)).toEqual(['database', 'build', 'migrate']);
  });
});

describe('what the owner reads', () => {
  it('renders one line per step, with the reason in parentheses', () => {
    const lines = renderPlan(planInit(FINISHED)).split('\n');
    expect(lines).toHaveLength(STEP_IDS.length);
    expect(lines.join('\n')).toContain('(already set)');
  });

  it('ends with three concrete first messages', () => {
    expect(FIRST_MESSAGES).toHaveLength(3);
    const text = nextSteps(planInit(FINISHED)).join('\n');
    for (const message of FIRST_MESSAGES) expect(text).toContain(message);
  });

  it('names the commands for whatever it could not do', () => {
    const text = nextSteps(planInit({ ...FRESH, interactive: false, hasBotToken: true })).join('\n');
    expect(text).toContain('buddi service install');
    expect(text).toContain('buddi telegram pair');
    expect(text).toContain('buddi doctor');
  });

  it('does not offer to install a service that is already installed', () => {
    const text = nextSteps(planInit(FINISHED)).join('\n');
    expect(text).not.toContain('buddi service install');
    expect(text).not.toContain('buddi telegram pair');
  });
});
