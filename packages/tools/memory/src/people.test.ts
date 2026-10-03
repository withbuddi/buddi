/** Pure rules of People: what a note names, the one-line context, when the owner said it. */
import { describe, expect, it } from 'vitest';
import { ownerStatedIt, peopleInNotes, peopleLines, personLine, proposalSentence, type PersonView } from './people.js';
import type { ToolContext } from '@buddi/core/plugin';

const note = (content: string) => ({ content, createdBy: 'concierge', createdAt: '2026-10-02T10:00:00.000Z' });
const someone = (over: Partial<PersonView>): PersonView => ({
  id: '00000000-0000-4000-8000-000000000000', name: 'X', relationship: null, addressAs: null, birthday: null, anniversary: null,
  notes: null, createdBy: 'owner', createdAt: null, updatedAt: null, ...over,
});

describe('people in notes', () => {
  it('finds a name and a relationship in the ways agents write them', () => {
    const found = peopleInNotes([
      note('Marion is your wife.'),
      note("The owner's brother is called Ben."),
      note("Claire Dubois, the owner's accountant, prefers mail."),
      note('My sister Lena loves ceramics. Lena\'s birthday is on March 4th.'),
      note('The owner prefers short answers.'),
      note('The owner is your friend.'),
    ]);
    expect(found.map((f) => [f.name, f.relationship])).toEqual([
      ['Marion', 'wife'], ['Ben', 'brother'], ['Claire Dubois', 'accountant'], ['Lena', 'sister'],
    ]);
    expect(found.find((f) => f.name === 'Lena')!.birthday).toEqual({ day: 4, month: 3, year: null });
  });
});

describe('the one-line context', () => {
  it('says who they are, how to address them and the dates, soonest first, notes left out', () => {
    const mum = someone({ name: 'Nkem', relationship: 'mother', addressAs: 'Mum', birthday: { day: 30, month: 1, year: null }, notes: 'secret' });
    const ben = someone({ name: 'Ben', relationship: 'brother', birthday: { day: 4, month: 10, year: 1991 } });
    expect(personLine(mum, '2026-10-03')).toBe('- Nkem: mother; addressed as "Mum"; birthday 30 January');
    expect(peopleLines([mum, ben], '2026-10-03')).toEqual([
      '- Ben: brother; birthday 4 October 1991 (in 1 day, turning 35)',
      '- Nkem: mother; addressed as "Mum"; birthday 30 January',
    ]);
    expect(personLine(someone({ name: 'M', anniversary: { day: 3, month: 10, year: 2014 } }), '2026-10-03')).toBe('- M: anniversary 3 October 2014 (today, 12 years)');
  });
  it('words a card in one sentence', () => {
    expect(proposalSentence('Ben', { relationship: 'brother', birthday: { day: 9, month: 10, year: null } }, null)).toBe('Remember Ben: brother, birthday 9 October.');
  });
});

describe('the owner said it', () => {
  const now = new Date('2026-10-03T09:00:00Z');
  const turn = (text: string, extra: Partial<ToolContext> = {}): ToolContext => ({ ownerRequest: { id: 'r', text, expiresAt: now.getTime() + 1000 }, ...extra });
  it('only in an owner turn naming them, with nothing untrusted in view and no delegation', () => {
    expect(ownerStatedIt(turn('Marion is my wife'), 'Marion', now)).toBe(true);
    expect(ownerStatedIt(turn('marion durand is my wife'), 'Marion Durand', now)).toBe(true);
    expect(ownerStatedIt(turn('marion is my wife'), 'Marion Durand', now)).toBe(false);
    expect(ownerStatedIt(turn('I also need a gift'), 'Al', now)).toBe(false);
    expect(ownerStatedIt(turn('Al, my brother, turns 40'), 'Al', now)).toBe(true);
    expect(ownerStatedIt(turn("Zoë's birthday is in May"), 'Zoë', now)).toBe(true);
    // The facts saved must be in the owner's words too.
    expect(ownerStatedIt(turn('Marion is my wife'), 'Marion', now, { name: 'Marion', relationship: 'wife' })).toBe(true);
    expect(ownerStatedIt(turn('Marion is my wife'), 'Marion', now, { name: 'Marion', relationship: 'sister' })).toBe(false);
    expect(ownerStatedIt(turn("Marion's birthday is 14 March"), 'Marion', now, { name: 'Marion', birthday: { day: 14, month: 3, year: null } })).toBe(true);
    expect(ownerStatedIt(turn("Marion's birthday is March 14th"), 'Marion', now, { name: 'Marion', birthday: { day: 14, month: 3, year: null } })).toBe(true);
    expect(ownerStatedIt(turn("Marion's birthday is 14/03"), 'Marion', now, { name: 'Marion', birthday: { day: 14, month: 3, year: null } })).toBe(true);
    expect(ownerStatedIt(turn('Marion is coming over'), 'Marion', now, { name: 'Marion', birthday: { day: 14, month: 3, year: null } })).toBe(false);
    expect(ownerStatedIt(turn("Marion's birthday is 4 March"), 'Marion', now, { name: 'Marion', birthday: { day: 14, month: 3, year: null } })).toBe(false);
    expect(ownerStatedIt(turn('she is my wife'), 'Marion', now)).toBe(false);
    expect(ownerStatedIt({}, 'Marion', now)).toBe(false);
    expect(ownerStatedIt(turn('Marion', { delegationDepth: 1 }), 'Marion', now)).toBe(false);
    expect(ownerStatedIt(turn('Marion', { provenance: () => ({ runId: null, turn: 1, step: 1, sources: [{ kind: 'web', via: 'web.read' }] }) }), 'Marion', now)).toBe(false);
    expect(ownerStatedIt({ ownerRequest: { id: 'r', text: 'Marion', expiresAt: now.getTime() - 1 } }, 'Marion', now)).toBe(false);
  });
});
