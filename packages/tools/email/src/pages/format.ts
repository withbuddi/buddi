/**
 * The sentences the mail pages show, written here rather than in the browser.
 *
 * A page descriptor draws *values*, and only the components that carry a unit
 * (`stats`, `detail`, `table`) format anything at all: a list row's title, sub
 * and meta are text, exactly as the query hands them over. So the wording that
 * used to live in `Mail.tsx` and `Email.tsx` — "edited by you, 3 days ago",
 * "learned from your mail · 12 runs saved" — lives here, where the rows are
 * made, and the page stays a tree of components that knows no domain.
 *
 * Everything here is pure: a row, a clock, a sentence.
 */
import type { DraftRecord } from '../rows.js';

/** `3 days ago`, in the same words the dashboard used to write client-side. */
export function relative(iso: string | null | undefined, now: Date): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const delta = Math.round((then - now.getTime()) / 1000);
  const abs = Math.abs(delta);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [delta, 'second']
      : abs < 3600
        ? [Math.round(delta / 60), 'minute']
        : abs < 86_400
          ? [Math.round(delta / 3600), 'hour']
          : [Math.round(delta / 86_400), 'day'];
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(value, unit);
}

/** What the page says about where a draft is in its life. */
export function draftStatusLine(draft: DraftRecord, now: Date): string {
  const who = draft.editedBy === 'owner' ? 'you' : draft.createdByAgent;
  const when = draft.updatedAt ? relative(draft.updatedAt, now) : 'at some point';
  switch (draft.status) {
    case 'edited':
      return `Edited by you, ${when}. Written by ${draft.createdByAgent}.`;
    case 'sent':
      return `Sent ${draft.sentAt ? relative(draft.sentAt, now) : when}. Written by ${draft.createdByAgent}.`;
    case 'discarded':
      return `Discarded ${when}. Written by ${draft.createdByAgent}.`;
    case 'lapsed':
      return `Lapsed ${when} — nothing touched it for a fortnight, so it is no longer sendable. Written by ${draft.createdByAgent}.`;
    default:
      return `Written by ${who}, ${when}.`;
  }
}

/** Where a rule came from, in the owner's words. */
export function originWord(origin: string): string {
  if (origin === 'owner') return 'you decided it';
  if (origin === 'learned') return 'learned from your mail';
  return 'from a plugin';
}

/** The one line under a rule: where it came from, and what it has done. */
export function policyLine(
  policy: {
    scope: string;
    origin: string;
    learnedFrom: number;
    proposed: boolean;
    runsSaved: number;
    createdAt: string | null;
    keptAt?: string | null;
  },
  now: Date,
): string {
  const parts = [`${policy.scope}, ${originWord(policy.origin)}`];
  if (policy.learnedFrom > 0) parts.push(`from ${policy.learnedFrom} verdicts`);
  parts.push(
    policy.proposed
      ? 'deciding nothing yet'
      : policy.runsSaved === 0
        ? 'no runs saved yet'
        : `${policy.runsSaved} run${policy.runsSaved === 1 ? '' : 's'} saved`,
  );
  // A rule kept from Proposals says when it was kept, not when it was learned.
  if (policy.keptAt) parts.push(`kept ${relative(policy.keptAt, now)}`);
  else if (policy.createdAt) parts.push(relative(policy.createdAt, now));
  return parts.join(' · ');
}

/** A timestamp as an ISO string, whatever `pg` handed back. */
export function isoOf(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value !== '' ? value : null;
}
