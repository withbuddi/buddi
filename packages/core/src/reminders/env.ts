/**
 * The reminder budget, read from the environment.
 *
 * The numbers in `types.ts` are the shipped defaults, not a law: "at least five
 * minutes out" is a judgement about what separates a reminder from an answer,
 * and the owner of an installation is better placed to make it than we are. So
 * each one has an environment variable, and every variable is clamped to a
 * range that keeps the tool a reminder tool — a lead of zero would make
 * `reminder.set` a way to spam the run loop, and an unbounded pending count
 * would undo the arithmetic that makes the tool safe without approval.
 *
 * A value that does not parse, or that falls outside the range, is *not* a
 * startup failure: the default is used and the reason is logged once. A typo in
 * an optional tuning knob should never keep the machine from coming up, and a
 * silent fallback would leave the owner believing a limit they do not have.
 */
import { DEFAULT_REMINDER_LIMITS, type ReminderLimits } from './types.js';

export interface ReminderLimitSpec {
  /** The environment variable that sets it. */
  env: string;
  /** The shipped value, used when the variable is absent or unusable. */
  fallback: number;
  min: number;
  max: number;
}

/** Every tunable limit, its variable, and the range it is held to. */
export const REMINDER_LIMIT_SPECS: Record<
  'minLeadMinutes' | 'maxHorizonDays' | 'maxPendingPerAgent' | 'maxPendingTotal',
  ReminderLimitSpec
> = {
  minLeadMinutes: {
    env: 'BUDDI_REMINDER_MIN_LEAD_MINUTES',
    fallback: DEFAULT_REMINDER_LIMITS.minLeadMinutes,
    min: 1,
    max: 1440,
  },
  maxHorizonDays: {
    env: 'BUDDI_REMINDER_MAX_HORIZON_DAYS',
    fallback: DEFAULT_REMINDER_LIMITS.maxHorizonDays,
    min: 1,
    max: 3650,
  },
  maxPendingPerAgent: {
    env: 'BUDDI_REMINDER_MAX_PENDING_PER_AGENT',
    fallback: DEFAULT_REMINDER_LIMITS.maxPendingPerAgent,
    min: 1,
    max: 100,
  },
  maxPendingTotal: {
    env: 'BUDDI_REMINDER_MAX_PENDING_TOTAL',
    fallback: DEFAULT_REMINDER_LIMITS.maxPendingTotal,
    min: 1,
    max: 500,
  },
};

export interface ReminderLimitsFromEnvOptions {
  /** Where a complaint about an unusable value goes. Defaults to stderr. */
  log?: (line: string) => void;
}

/** The variables we have already complained about, so a boot says each once. */
const complained = new Set<string>();

function readLimit(
  spec: ReminderLimitSpec,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): number {
  const raw = (env[spec.env] ?? '').trim();
  if (raw === '') return spec.fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    if (!complained.has(spec.env)) {
      complained.add(spec.env);
      log(
        `${spec.env}="${raw}" is not a whole number; using the default ${spec.fallback}`,
      );
    }
    return spec.fallback;
  }

  if (parsed < spec.min || parsed > spec.max) {
    const clamped = Math.min(Math.max(parsed, spec.min), spec.max);
    if (!complained.has(spec.env)) {
      complained.add(spec.env);
      log(
        `${spec.env}=${parsed} is outside ${spec.min}..${spec.max}; using ${clamped}`,
      );
    }
    return clamped;
  }
  return parsed;
}

/**
 * The limits this installation runs with.
 *
 * `maxTextChars` is deliberately not tunable: it is a shape constraint on the
 * note ("a nudge, not a report"), not a budget, and nothing good comes of an
 * owner raising it.
 */
export function reminderLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: ReminderLimitsFromEnvOptions = {},
): ReminderLimits {
  const log = opts.log ?? ((line: string) => console.error(`reminders: ${line}`));
  return {
    minLeadMinutes: readLimit(REMINDER_LIMIT_SPECS.minLeadMinutes, env, log),
    maxHorizonDays: readLimit(REMINDER_LIMIT_SPECS.maxHorizonDays, env, log),
    maxPendingPerAgent: readLimit(REMINDER_LIMIT_SPECS.maxPendingPerAgent, env, log),
    maxPendingTotal: readLimit(REMINDER_LIMIT_SPECS.maxPendingTotal, env, log),
    maxTextChars: DEFAULT_REMINDER_LIMITS.maxTextChars,
  };
}

/** Test seam: forget which variables have already been complained about. */
export function resetReminderLimitWarnings(): void {
  complained.clear();
}
