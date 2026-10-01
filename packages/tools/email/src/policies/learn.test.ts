/**
 * What three verdicts running are allowed to conclude, and what they are not.
 */
import { describe, expect, it } from 'vitest';
import { CONSISTENT_VERDICTS, learnedProposal, type Verdict } from './learn.js';
import { learnedLine, mayKeepItself } from './auto.js';
import { isBulkHeaders, isNoReplyAddress } from '../mail.js';

function verdicts(...pairs: Array<[string, string]>): Verdict[] {
  return pairs.map(([category, urgency], i) => ({
    messageId: `m${i}`,
    processingVersion: 2,
    category,
    urgency,
    decidedAt: `2026-09-0${9 - i}T00:00:00.000Z`,
  }));
}

const promo = verdicts(['promo', 'low'], ['promo', 'low'], ['promo', 'low']);

describe('learnedProposal', () => {
  it('concludes nothing from two verdicts', () => {
    expect(learnedProposal(promo.slice(0, 2), false)).toBeNull();
    expect(CONSISTENT_VERDICTS).toBe(3);
  });

  it('proposes — never applies — an ignore for three promo verdicts and no reply', () => {
    // docs/email.md §3: "no reply" is read off the owner's Sent folder, which
    // is synced from the day buddi arrived and not from the day the mailbox
    // was made — so it still cannot silence anyone by itself.
    const proposal = learnedProposal(promo, false);
    expect(proposal).toMatchObject({ action: 'ignore', proposed: true });
    expect(proposal?.createdFrom).toHaveLength(3);
    expect(proposal?.createdFrom[0]).toEqual({ messageId: 'm0', processingVersion: 2 });
  });

  it('proposes and applies nothing at all — every rule it makes is a suggestion', () => {
    const all = [
      learnedProposal(promo, false),
      learnedProposal(verdicts(['service-notice', 'low'], ['other', 'low'], ['promo', 'low']), false),
      learnedProposal(verdicts(['reply-needed', 'normal'], ['reply-needed', 'urgent'], ['reply-needed', 'low']), true),
    ].filter((p) => p !== null);
    expect(all).toHaveLength(3);
    expect(all.every((p) => p!.proposed)).toBe(true);
  });

  it('refuses to silence a sender the owner has written back to', () => {
    expect(learnedProposal(promo, true)).toBeNull();
  });

  it('counts only the newest run — one dissenting verdict resets it', () => {
    const mixed = verdicts(['promo', 'low'], ['reply-needed', 'normal'], ['promo', 'low'], ['promo', 'low']);
    expect(learnedProposal(mixed, false)).toBeNull();
  });

  it('proposes, without applying, an ignore for three low verdicts of mixed category', () => {
    const low = verdicts(['service-notice', 'low'], ['other', 'low'], ['promo', 'low']);
    expect(learnedProposal(low, false)).toMatchObject({ action: 'ignore', proposed: true });
  });

  it('proposes notify for a sender who keeps needing an answer', () => {
    const replies = verdicts(['reply-needed', 'normal'], ['reply-needed', 'urgent'], ['reply-needed', 'normal']);
    expect(learnedProposal(replies, true)).toMatchObject({ action: 'notify', proposed: true });
  });

  it('concludes nothing from three consistent verdicts that mean work', () => {
    const bills = verdicts(['bill', 'normal'], ['bill', 'urgent'], ['bill', 'normal']);
    expect(learnedProposal(bills, false)).toBeNull();
  });
});

describe('what may keep itself', () => {
  const base = { scope: 'sender', action: 'ignore', ownerHasWritten: false, bulk: true, trusted: false };

  it('keeps only a quiet rule, for a sender the owner never wrote to, that is bulk or of a trusted kind', () => {
    expect(mayKeepItself(base)).toBe('bulk');
    expect(mayKeepItself({ ...base, bulk: false, trusted: true })).toBe('track-record');
    expect(mayKeepItself({ ...base, bulk: false })).toBeNull();
    expect(mayKeepItself({ ...base, ownerHasWritten: true, trusted: true })).toBeNull();
  });

  it('never keeps anything but quiet, and never a move or anything past mark-read and archive on arrival', () => {
    for (const action of ['notify', 'draft', 'hand-to-agent', 'wake', 'archive', 'label']) {
      expect(mayKeepItself({ ...base, action, trusted: true })).toBeNull();
    }
    expect(mayKeepItself({ ...base, params: { onArrival: { kind: 'move', folder: 'Trash' } } })).toBeNull();
    expect(mayKeepItself({ ...base, params: { onArrival: { kind: 'archive' } } })).toBe('bulk');
    expect(mayKeepItself({ ...base, params: { onArrival: { kind: 'mark-read' } } })).toBe('bulk');
    expect(mayKeepItself({ ...base, scope: 'domain' })).toBeNull();
  });

  it('reads bulk off the headers and no-reply off the address', () => {
    expect(isBulkHeaders({ 'list-unsubscribe': '<mailto:u@x.test>' })).toBe(true);
    expect(isBulkHeaders({ precedence: 'Bulk' })).toBe(true);
    expect(isBulkHeaders({ precedence: 'first-class' })).toBe(false);
    expect(isBulkHeaders({})).toBe(false);
    for (const a of ['noreply@x.test', 'No-Reply <no-reply@x.test>', 'donotreply@x.test', 'do-not-reply+12@x.test', 'noreply-billing@x.test']) {
      expect(isNoReplyAddress(a)).toBe(true);
    }
    for (const a of ['news@x.test', 'replyall@x.test', 'nora@x.test']) expect(isNoReplyAddress(a)).toBe(false);
  });

  it('says what kept itself in one line, and nothing at zero', () => {
    expect(learnedLine({ bulk: 0, trackRecord: 0 })).toBeNull();
    expect(learnedLine({ bulk: 7, trackRecord: 0 })).toBe('buddi learned 7 rules: quieted 7 newsletters — review');
    expect(learnedLine({ bulk: 1, trackRecord: 2 })).toBe('buddi learned 3 rules: quieted 1 newsletter and 2 senders — review');
  });
});
