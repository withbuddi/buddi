/**
 * The decision a narrow draft leaves behind.
 *
 * `email.draft_reply`'s recipients are tested against a real database in
 * `tools.db.test.ts`; what is tested here is the sentence the result carries,
 * because that sentence is the mechanism. The agent did not skip the buttons
 * for want of a persona paragraph — it skipped them because at the moment the
 * choice existed, nothing in front of it said so. So the rule that decides
 * whether anything is pending is a pure function, and it is pinned here.
 */
import { describe, expect, it } from 'vitest';
import { describeAudienceDecision, draftReply } from './drafts.js';

const sender = 'tdorothee22@gmail.com';

describe('the decision a reply leaves the owner', () => {
  it('exists when the draft went narrow and other people were on the original', () => {
    const decision = describeAudienceDecision({
      audience: 'sender',
      sender,
      othersOnOriginal: ['rachid@x.test', 'fiatyao@x.test', 'paul@x.test', 'cdc@x.test'],
    });
    expect(decision).not.toBeNull();
    expect(decision?.decision).toBe('reply-audience');
    expect(decision?.others).toHaveLength(4);
    // Both ways it could go, named — an offer written from this needs no
    // judgement about what the two moves are.
    expect(decision?.options[0]).toContain(`${sender} alone`);
    expect(decision?.options[1]).toContain('rachid@x.test');
    expect(decision?.instruction).toMatch(/4 other people/);
    expect(decision?.instruction).toMatch(/cannot be taken back/i);
    // Naming the two moves was not enough on its own: the first live run
    // listed them as bullets and called no tool. The instruction names the
    // mechanism, and rules out the paragraph that looks like it.
    expect(decision?.instruction).toMatch(/offering the owner what to do next/i);
    expect(decision?.instruction).toMatch(/do not also list the two options in your own text/i);
    expect(decision?.instruction).toMatch(/show the owner that draft/i);
    expect(decision?.instruction).toMatch(/call that tool first and write the reply after it/i);
    expect(decision?.instruction).toMatch(/shall I send it/i);
  });

  it('says "person" for one, and names them', () => {
    const decision = describeAudienceDecision({
      audience: 'sender',
      sender,
      othersOnOriginal: ['rachid@x.test'],
    });
    expect(decision?.instruction).toMatch(/1 other person/);
    expect(decision?.instruction).toContain('rachid@x.test');
  });

  it('is nothing at all when the message was only between the two of them', () => {
    // The other failure mode. A button here is noise, and noise is what stops
    // the owner reading the one that mattered.
    expect(
      describeAudienceDecision({ audience: 'sender', sender, othersOnOriginal: [] }),
    ).toBeNull();
  });

  it('is nothing once the wide shape has already been chosen', () => {
    expect(
      describeAudienceDecision({
        audience: 'everyone',
        sender,
        othersOnOriginal: ['rachid@x.test'],
      }),
    ).toBeNull();
  });

  it('warns in the tool description that the narrow shape still reports the others', () => {
    expect(draftReply.description).toMatch(/even when you chose the narrow shape/i);
    expect(draftReply.description).toMatch(/leaves the owner a decision/i);
  });
});
