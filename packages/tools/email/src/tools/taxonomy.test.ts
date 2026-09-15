/**
 * The taxonomy and the ladder, as a contract rather than as prose.
 *
 * This file exists because of one message. A client of many years wrote to say
 * she was retiring and to name her successors, and it came out `personal` /
 * `low` and was never reported — not because the model reasoned badly, but
 * because seven of the eight categories it could choose from named a kind of
 * transaction and the urgency ladder was defined entirely in money. There was
 * no correct answer available to it.
 *
 * So what is asserted here is the *shape of the choice*: that a person waiting,
 * a relationship changing, an obligation with no money attached and a security
 * event each have somewhere to go, that money is a part of the taxonomy rather
 * than the whole of it, and that the ladder is written in terms of consequence.
 */
import { describe, expect, it } from 'vitest';
import { triageRecord } from './triage.js';
import {
  CATEGORIES,
  categoryLabel,
  isKnownCategory,
  KNOWN_CATEGORIES,
  LEGACY_CATEGORIES,
  PROCESSING_VERSION,
  URGENCIES,
} from './shared.js';

/** Every category the money-only policy (version 1) could write. */
const VERSION_1_CATEGORIES = [
  'bill',
  'bank-notice',
  'payment-failed',
  'statement',
  'receipt',
  'personal',
  'promo',
  'other',
] as const;

/** The categories that are about a transaction. */
const MONEY = ['bill', 'bank-notice', 'payment-failed', 'statement', 'receipt'];

describe('the triage taxonomy', () => {
  it('gives a person who is waiting somewhere to go', () => {
    expect(CATEGORIES).toContain('reply-needed');
  });

  it('gives a relationship that is changing somewhere to go', () => {
    // The missed message. `personal` was the only home it had.
    expect(CATEGORIES).toContain('relationship');
  });

  it('gives an obligation with no money attached somewhere to go', () => {
    expect(CATEGORIES).toContain('obligation');
  });

  it('gives an opportunity and a security event somewhere to go', () => {
    expect(CATEGORIES).toContain('opportunity');
    expect(CATEGORIES).toContain('security');
  });

  it('keeps every money category that earned its place', () => {
    for (const category of MONEY) expect(CATEGORIES).toContain(category);
  });

  it('is no longer mostly about money', () => {
    // Version 1 was seven of eight. The bar here is deliberately loose — the
    // claim is not "exactly five of fourteen", it is "money stopped being the
    // default answer".
    const share = MONEY.length / CATEGORIES.length;
    expect(share).toBeLessThan(0.5);
  });

  it('holds no duplicates', () => {
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);
  });
});

describe('what happens to the rows already stored', () => {
  it('writes a new policy version, so a re-triage lands beside the old decision', () => {
    expect(PROCESSING_VERSION).toBeGreaterThan(1);
  });

  it('still recognises every category the old policy wrote', () => {
    // This is the migration answer: not one stored row holds a category this
    // build cannot name, so there is nothing to rewrite and nothing to break.
    for (const old of VERSION_1_CATEGORIES) {
      expect(isKnownCategory(old)).toBe(true);
    }
  });

  it('keeps the three urgency values, so the check constraint still holds', () => {
    // `email.triage.urgency` carries `check (urgency in ('urgent','normal','low'))`.
    // Version 2 redefines what the rungs *mean*; adding a fourth would have
    // needed a migration, and this is what says so out loud.
    expect([...URGENCIES]).toEqual(['urgent', 'normal', 'low']);
  });

  it('names a category it has never heard of rather than failing on it', () => {
    // A view that throws because a value left the enum would turn the next
    // policy change into a broken page.
    expect(categoryLabel('a-category-from-2029')).toBe('a category from 2029');
    expect(categoryLabel('')).toBe('uncategorised');
    expect(isKnownCategory('a-category-from-2029')).toBe(false);
  });

  it('counts retired categories among the known ones', () => {
    for (const retired of LEGACY_CATEGORIES) {
      expect(KNOWN_CATEGORIES).toContain(retired);
      expect(isKnownCategory(retired)).toBe(true);
    }
  });
});

describe('the urgency ladder, as the tool states it', () => {
  const shape = triageRecord.input as unknown as {
    shape: Record<string, { description?: string; _def?: { description?: string } }>;
  };
  const describes = (field: string): string => {
    const entry = shape.shape[field];
    return (entry?.description ?? entry?._def?.description ?? '').toLowerCase();
  };

  it('defines urgency by consequence, not by the presence of a sum', () => {
    const urgency = describes('urgency');
    expect(urgency).toContain('consequence');
    // A person, a relationship, an opportunity and a deadline can all be urgent.
    expect(urgency).toMatch(/waiting/);
    expect(urgency).toMatch(/relationship|standing/);
    expect(urgency).toMatch(/opportunity/);
    expect(urgency).toMatch(/deadline/);
  });

  it('keeps money as one of the things that can be lost', () => {
    expect(describes('urgency')).toContain('money');
  });

  it('will not let something with a real next step be called low', () => {
    // The tuning that came out of running the owner's own mailbox: an errand
    // with no deadline ("your document is signed and ready for pickup") was
    // landing as `other`/`low` with a perfectly good sentence in actionNeeded.
    expect(describes('urgency')).toContain('actionneeded');
  });

  it('keeps the bar meaningful', () => {
    // "Less restrictive" was a request for correct judgement, not for chatter.
    expect(describes('urgency')).toContain('never urgent');
  });

  it('names the new categories where the model will read them', () => {
    const category = describes('category');
    for (const named of ['reply-needed', 'relationship', 'obligation', 'security', 'opportunity']) {
      expect(category).toContain(named);
    }
  });
});
