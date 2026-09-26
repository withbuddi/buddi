/**
 * A new proposal, told to the owner (docs/notifications.md).
 *
 * A proposal waits on Settings → Proposals, where an owner who never goes
 * there never meets it. So each new one is also a notification: kind
 * `plugin`, urgency `today`, which means it keeps quiet hours and arrives
 * with the end-of-day message rather than the moment an agent thought of it.
 * A channel that draws cards (Telegram) draws this one with Keep and Discard,
 * found by its dedupe key, `proposal:<id>`.
 *
 * Never allowed to fail the proposal: the card on the Proposals page is the
 * record, and a message that could not be written is only a message.
 */
import type { Queryable } from '../owner.js';
import { markActedForKey } from '../notifications/store.js';
import { notifyOwner } from '../notifications/notify.js';
import type { Proposal } from './types.js';

/** The dedupe key a proposal's notification carries; a channel reads the id back from it. */
export function proposalNotificationKey(id: string): string {
  return `proposal:${id}`;
}

/** The proposal id a notification is about, or undefined when it is about something else. */
export function proposalIdOfKey(key: string | undefined | null): string | undefined {
  const m = /^proposal:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec((key ?? '').trim());
  return m ? (m[1] as string).toLowerCase() : undefined;
}

/**
 * The notification's one line. No agent name: every channel already says
 * whose it is (`agentId`), and the end-of-day message puts it in front.
 */
export function proposalNotificationTitle(proposal: Pick<Proposal, 'kind' | 'payload'>): string {
  const p = proposal.payload;
  switch (proposal.kind) {
    case 'skill':
      return `Proposes a skill: ${String(p.name ?? 'unnamed')}`;
    case 'policy':
      return `Proposes a rule for ${String(p.plugin ?? 'a plugin')}: ${String(p.action ?? '')}`.trim();
    case 'change':
      return p.part === 'tools' ? 'Proposes a change to its tools' : 'Proposes a change to its instructions';
  }
}

/** Tell the owner about a new proposal. Swallows every failure; see the header. */
export async function announceProposal(
  db: Queryable,
  proposal: Proposal,
  now: Date,
  log?: (line: string) => void,
): Promise<void> {
  const why = typeof proposal.payload.why === 'string' ? proposal.payload.why.trim() : '';
  try {
    await notifyOwner(db, { now: () => now }, {
      kind: 'plugin',
      urgency: 'today',
      title: proposalNotificationTitle(proposal),
      ...(why ? { text: why.length > 600 ? `${why.slice(0, 599)}…` : why } : {}),
      link: { route: '#/settings/proposals' },
      agentId: proposal.agent,
      dedupeKey: proposalNotificationKey(proposal.id),
    });
  } catch (err) {
    log?.(`learning: could not tell the owner about proposal ${proposal.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The owner decided it, wherever: its notification is acted on. Never throws. */
export async function proposalDecided(db: Queryable, id: string, now: Date): Promise<void> {
  await markActedForKey(db, proposalNotificationKey(id), now).catch(() => 0);
}
