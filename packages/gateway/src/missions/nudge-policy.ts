/**
 * The budget for the first-two-weeks arc, as one readable rule.
 *
 * A newly installed system has to earn a habit, and quiet-by-default will never
 * build one: silence in week one reads as "this does not work". So the arc
 * exists — and the moment it exists, so does the risk that it becomes the thing
 * that teaches the owner to mute us.
 *
 * The defence is that the budget is *code*, not prompt. A model asked to "be
 * considerate" is being asked to hold a counter it cannot see. Here the counter
 * is real, the clock is injected, and the whole rule is four refusals and a
 * happy path that fit on one screen:
 *
 *   quiet      — the owner asked for silence, explicitly and with an end date
 *   unanswered — three in a row with no reply; the answer is no
 *   exhausted  — fourteen messages is the whole arc
 *   too-soon   — at most one a day, whatever else is true
 *
 * Precedence is deliberate and is the order above: an owner who typed `/quiet`
 * is refused for *that* reason and not for a pacing rule that happened to fire
 * first, because the reason is what the event log records and what
 * `buddi nudges status` shows them.
 *
 * Nothing in this file touches a database, a clock or a surface.
 */

/** The whole arc: fourteen messages, one for each day of the two weeks. */
export const MAX_NUDGES = 14;

/**
 * The floor between two proactive messages. Twenty rather than twenty-four so a
 * daily mission does not skip a day because yesterday's run was four minutes
 * late; short enough that it can never mean two in one morning.
 */
export const MIN_GAP_HOURS = 20;

/** Three in a row with no reply. The fourth is not a nudge, it is nagging. */
export const MAX_UNANSWERED = 3;

/** How long the arc stays open after onboarding completes. */
export const ARC_WINDOW_DAYS = 14;

/** `/quiet` with no argument. */
export const DEFAULT_QUIET_DAYS = 7;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * What the budget is decided from. Exactly the columns the onboarding row
 * carries — no mission, no agent, nothing that could make this impure.
 */
export interface NudgeState {
  nudgesSent: number;
  lastNudgeAt: Date | null;
  quietUntil: Date | null;
  unanswered: number;
}

export type NudgeRefusal = 'quiet' | 'unanswered' | 'exhausted' | 'too-soon';

export type NudgeDecision =
  | { allow: true; reason: 'ok' }
  | { allow: false; reason: NudgeRefusal };

/**
 * May the arc speak right now?
 *
 * Pure and total: every input produces one of five answers, and the five are
 * the whole truth table the tests enumerate.
 */
export function nudgePolicy(state: NudgeState, now: Date): NudgeDecision {
  if (state.quietUntil !== null && state.quietUntil.getTime() > now.getTime()) {
    return { allow: false, reason: 'quiet' };
  }
  if (state.unanswered >= MAX_UNANSWERED) {
    return { allow: false, reason: 'unanswered' };
  }
  if (state.nudgesSent >= MAX_NUDGES) {
    return { allow: false, reason: 'exhausted' };
  }
  if (
    state.lastNudgeAt !== null &&
    now.getTime() - state.lastNudgeAt.getTime() < MIN_GAP_HOURS * HOUR_MS
  ) {
    return { allow: false, reason: 'too-soon' };
  }
  return { allow: true, reason: 'ok' };
}

/** One line for the event log and for `buddi nudges status`. */
export function refusalText(reason: NudgeRefusal): string {
  switch (reason) {
    case 'quiet':
      return 'the owner asked for quiet';
    case 'unanswered':
      return `${MAX_UNANSWERED} messages in a row went unanswered`;
    case 'exhausted':
      return `the arc's ${MAX_NUDGES}-message budget is spent`;
    case 'too-soon':
      return `less than ${MIN_GAP_HOURS} hours since the last one`;
  }
}

/**
 * A refusal that ends the arc rather than postponing it. `quiet` and `too-soon`
 * are both temporary; the other two are the arc being over.
 */
export function endsTheArc(reason: NudgeRefusal): boolean {
  return reason === 'unanswered' || reason === 'exhausted';
}

/* ------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------ */

/**
 * The slice of the onboarding row this file needs.
 *
 * Declared structurally on purpose: `core.onboarding` and its accessors belong
 * to the first-run interview, and the arc reads them without owning them.
 */
export interface OnboardingWindowState {
  state: string;
  completedAt: Date | null;
  /** Which surface the interview happened on. `pre-existing` means it did not. */
  surface: string | null;
}

/**
 * The `surface` migration 013 stamps on installations that were already running
 * when onboarding shipped. Their row says `done` with `completed_at = now()`,
 * which is honest about the interview and would otherwise read as "finished
 * today" — opening a fourteen-day arc for an owner who is months in.
 */
export const BACKFILLED_SURFACE = 'pre-existing';

/**
 * The surface the dashboard's first-run wizard stamps on the record.
 *
 * The arc exists to carry an owner who met buddi *in a chat* through their
 * first two weeks of it. An owner who set up in the dashboard has the dashboard
 * — Home says what needs them, and every screen the nudges would point at is
 * one click away — so the arc has nothing to add and would arrive as unasked-for
 * Telegram messages about a surface they already have open.
 */
export const WEB_WIZARD_SURFACE = 'web';

export interface ArcWindow {
  open: boolean;
  /** One sentence, for the log line and for `buddi nudges status`. */
  reason: string;
}

/**
 * Is this installation still inside its first two weeks?
 *
 * Five answers, and none of them is "probably":
 *  - no onboarding row at all — this install never ran the interview, so it has
 *    no first run to be inside of, and nowhere to keep the count either;
 *  - `pre-existing` — migration 013 wrote that row, not a conversation;
 *  - `web` — the owner set up in the dashboard, which is the arc's whole
 *    subject matter already;
 *  - `skipped` — the owner declined the interview; declining is an answer;
 *  - anything other than `done` — the interview is still going, so yes;
 *  - `done` — yes for fourteen days after `completed_at`, then never again.
 */
export function arcWindow(onboarding: OnboardingWindowState | null, now: Date): ArcWindow {
  if (onboarding === null) {
    return {
      open: false,
      reason: 'no onboarding record — this installation never ran the first-run interview',
    };
  }
  if (onboarding.surface === BACKFILLED_SURFACE) {
    return {
      open: false,
      reason: 'this installation predates onboarding — it is long past its first run',
    };
  }
  if (onboarding.surface === WEB_WIZARD_SURFACE) {
    return { open: false, reason: 'the owner set this installation up in the dashboard' };
  }
  if (onboarding.state === 'skipped') {
    return { open: false, reason: 'the owner skipped onboarding' };
  }
  if (onboarding.state !== 'done') {
    return { open: true, reason: `onboarding is still ${onboarding.state}` };
  }
  if (onboarding.completedAt === null) {
    return { open: false, reason: 'onboarding is done and carries no completion date' };
  }
  const days = (now.getTime() - onboarding.completedAt.getTime()) / DAY_MS;
  if (days <= ARC_WINDOW_DAYS) {
    return {
      open: true,
      reason: `day ${Math.max(1, Math.ceil(days))} of the first ${ARC_WINDOW_DAYS}`,
    };
  }
  return {
    open: false,
    reason: `onboarding completed ${Math.floor(days)} days ago, past the ${ARC_WINDOW_DAYS}-day window`,
  };
}

/* ------------------------------------------------------------------ *
 * The engagement preference
 * ------------------------------------------------------------------ */

/** The owner's standing choice about proactive messages. */
export type Engagement = 'arc' | 'quiet';

/** The preference key, shared across every agent. */
export const ENGAGEMENT_KEY = 'engagement';

/** Read a stored preference value, or `undefined` if it says nothing we know. */
export function parseEngagement(value: string | undefined | null): Engagement | undefined {
  const text = (value ?? '').trim().toLowerCase();
  if (text === 'arc') return 'arc';
  if (text === 'quiet') return 'quiet';
  return undefined;
}

/* ------------------------------------------------------------------ *
 * `/quiet`
 * ------------------------------------------------------------------ */

export type QuietRequest =
  | { kind: 'until'; until: Date; label: string }
  | { kind: 'off' }
  | { kind: 'unparsable'; text: string };

const QUIET_DURATION = /^(\d{1,3})\s*([hdw])$/i;

/**
 * `/quiet`, `/quiet 1d`, `/quiet 1w`, `/quiet off`.
 *
 * Pure, and the clock arrives as an argument so "one week from now" is a fact
 * about the call rather than about when the test ran. A bare `/quiet` is seven
 * days: the owner reaching for it wants the noise to stop, not to do arithmetic.
 */
export function parseQuiet(arg: string, now: Date): QuietRequest {
  const text = arg.trim().toLowerCase();
  if (text === '') {
    return {
      kind: 'until',
      until: new Date(now.getTime() + DEFAULT_QUIET_DAYS * DAY_MS),
      label: `${DEFAULT_QUIET_DAYS} days`,
    };
  }
  if (text === 'off' || text === 'stop' || text === 'end') return { kind: 'off' };

  const match = QUIET_DURATION.exec(text);
  if (!match) return { kind: 'unparsable', text: arg.trim() };
  const count = Number(match[1]);
  const unit = (match[2] as string).toLowerCase();
  if (!Number.isInteger(count) || count < 1) return { kind: 'unparsable', text: arg.trim() };

  const ms = unit === 'h' ? HOUR_MS : unit === 'd' ? DAY_MS : 7 * DAY_MS;
  const name = unit === 'h' ? 'hour' : unit === 'd' ? 'day' : 'week';
  return {
    kind: 'until',
    until: new Date(now.getTime() + count * ms),
    label: `${count} ${name}${count === 1 ? '' : 's'}`,
  };
}

/** The one line either form of `/quiet` answers with. */
export function quietConfirmation(request: QuietRequest, until?: string): string {
  if (request.kind === 'off') {
    return 'Quiet off — I can bring you something again when I find it.';
  }
  if (request.kind === 'unparsable') {
    return `I did not understand "${request.text}". Try /quiet, /quiet 1d, /quiet 1w or /quiet off.`;
  }
  return `Quiet for ${request.label}${until ? `, until ${until}` : ''}. Nothing proactive until then; ask me anything in the meantime.`;
}
