/**
 * What three verdicts running are allowed to conclude, and what they are not.
 */
import { describe, expect, it } from 'vitest';
import { CONSISTENT_VERDICTS, learnedProposal, type Verdict } from './learn.js';

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
    // docs/email.md §3: until the Sent folder is synced, "no reply" is read
    // off drafts buddi itself sent, so it cannot silence anyone by itself.
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
