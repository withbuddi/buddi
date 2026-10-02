/**
 * Whether a conversation needs the owner: the one rule (docs/email.md §2).
 *
 * `threads.state` is a fact — who wrote last — and stays one. A security
 * alert from `no-reply@` and a client's question both leave a thread
 * `waiting-on-me`; only one of them is waiting on anybody. This is the
 * judgement made over the fact, and it lives in one SQL function,
 * `email.thread_attention(thread, now)` (migration 023), so that the Mail
 * page, the "Waiting on you" widget, the watcher, the metric and the agents'
 * tools cannot disagree about which conversations they mean.
 *
 * For a `waiting-on-me` thread, read off its newest inbound message, the
 * first of these that holds is its reason:
 *
 *  0. `filed` — it is no longer in the inbox: gone, archived, labelled or
 *     trashed, in another mail app or by a change the owner approved
 *     (migration 026);
 *  1. `no-reply` — the sender is an address nobody reads (`no-reply@`,
 *     `…-noreply@`, `notifications@`, `mailer-daemon@`, `@noreply.host`);
 *  2. `bulk` — it was sent to many: `List-Unsubscribe`, `Precedence: bulk`,
 *     or a `List-Id`;
 *  3. `ignored` — a live ignore rule the owner kept covers its sender, domain,
 *     list or thread;
 *  4. `stale` — it arrived more than 30 days ago (or its messages aged out);
 *  5. `known` — the owner has written to this sender before, from this mailbox;
 *  6. `asked` — the latest triage verdict on it is `reply-needed`;
 *  7. `stranger` — somebody wrote, and nothing says a reply is expected.
 *
 * **Needs you = `known` or `asked`.** Every other state answers its own name.
 * The sender's headers only ever count *against* needing the owner — a forged
 * `List-Unsubscribe` can at worst make a message look like a newsletter.
 */
import type { ThreadState } from './threads.js';

export const ATTENTION_REASONS = [
  'known',
  'asked',
  'filed',
  'no-reply',
  'bulk',
  'ignored',
  'stale',
  'stranger',
  'waiting-on-them',
  'muted',
  'closed',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/** What the page shows for a conversation: the state as the owner reads it. */
export type AttentionView = 'needs-you' | 'notification' | 'they-wrote' | 'waiting-on-them' | 'muted' | 'closed';

export const ATTENTION_LABELS: Record<AttentionView, string> = {
  'needs-you': 'Waiting on you',
  notification: 'Notification',
  'they-wrote': 'They wrote',
  'waiting-on-them': 'Waiting on them',
  muted: 'Muted',
  closed: 'Closed',
};

/** Why, in a few words, as the detail's State row finishes its sentence. */
export const ATTENTION_WHY: Record<AttentionReason, string> = {
  known: 'you’ve written to them before',
  asked: 'they asked you something',
  filed: 'no reply expected: it is no longer in the inbox',
  'no-reply': 'no reply expected: a no-reply sender',
  bulk: 'no reply expected: sent to a list',
  ignored: 'no reply expected: you ignore this sender',
  stale: 'over 30 days old, no longer counted as waiting',
  stranger: 'no reply expected: you haven’t written to them before',
  'waiting-on-them': 'you wrote last',
  muted: 'you muted it; new mail doesn’t bring it back',
  closed: 'nothing more is expected',
};

export function isAttentionReason(value: unknown): value is AttentionReason {
  return typeof value === 'string' && (ATTENTION_REASONS as readonly string[]).includes(value);
}

/** The reason, or one derived from the state alone when there was none to read. */
export function reasonOf(raw: unknown, state: ThreadState): AttentionReason {
  if (isAttentionReason(raw)) return raw;
  return state === 'waiting-on-me' ? 'stranger' : state;
}

export function needsYou(reason: AttentionReason): boolean {
  return reason === 'known' || reason === 'asked';
}

export function viewOf(reason: AttentionReason): AttentionView {
  switch (reason) {
    case 'known':
    case 'asked':
      return 'needs-you';
    case 'no-reply':
    case 'bulk':
      return 'notification';
    case 'waiting-on-them':
    case 'muted':
    case 'closed':
      return reason;
    default:
      return 'they-wrote';
  }
}

/** The detail's State row: "Waiting on you — you’ve written to them before." */
export function attentionLine(reason: AttentionReason): string {
  return `${ATTENTION_LABELS[viewOf(reason)]} — ${ATTENTION_WHY[reason]}.`;
}

/**
 * The same sender pattern `email.is_notification_address` reads, for code
 * that has an address and no row. POSIX and JavaScript read it alike.
 */
const NOTIFICATION_LOCAL =
  /(^|[._+-])(no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon|postmaster|bounces?|notifications?|automated)($|[._+-])/;
const NOTIFICATION_HOST = /^(no[._-]?reply|do[._-]?not[._-]?reply)$/;

export function isNotificationAddress(raw: string): boolean {
  const inner = /<([^>]+)>/.exec(raw)?.[1] ?? raw;
  const address = inner.trim().replace(/^"+|"+$/g, '').toLowerCase();
  const at = address.indexOf('@');
  const local = at < 0 ? address : address.slice(0, at);
  const host = at < 0 ? '' : address.slice(at + 1).split('.')[0] ?? '';
  return NOTIFICATION_LOCAL.test(local) || NOTIFICATION_HOST.test(host);
}

/**
 * The lateral join that gives a thread aliased `t` its `att.needs_you`,
 * `att.reason`, `att.inbound_id` and `att.inbound_at`, as of `now` (a
 * placeholder such as `$2`).
 */
export function attentionJoin(t: string, now: string): string {
  return `cross join lateral email.thread_attention(${t}.id, ${now}::timestamptz) att`;
}

/**
 * What every needing thread already is, cheap to test before the function
 * runs: inbound last, and moved inside the window. A filter for a query that
 * only wants needing threads, ahead of `att.needs_you`.
 */
export function needsYouPrefilter(t: string, now: string): string {
  return (
    `${t}.state = 'waiting-on-me' and ` +
    `${t}.last_at >= ${now}::timestamptz - make_interval(days => email.attention_window_days())`
  );
}
