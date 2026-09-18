/**
 * The rule under test: an agent that ends a one-shot turn asking the owner
 * something owns the owner's next message, and then the chat goes back.
 *
 * This file tests the decision in isolation — what counts as a question, what
 * counts as an answer, and how long the claim lasts. The surfaces' own tests
 * prove that the routing and the markers follow from it.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@buddi/core';
import {
  ASK_TOOL,
  answerVerdict,
  capturedNote,
  createAskManifest,
  endedWithQuestion,
  MAX_ANSWER_CHARS,
  PendingQuestions,
  PENDING_TTL_MS,
  turnAskedOwner,
  type AskSink,
  type PendingQuestion,
} from './pending-question.js';

const QUESTION: Omit<PendingQuestion, 'captures'> = {
  askedAgentId: 'concierge',
  askedAgentName: 'Concierge',
  previousAgentId: 'postman',
  previousAgentName: 'Postman',
  at: 1_000,
};

describe('conversation.ask — the explicit signal', () => {
  it('records the question the run declared, and nothing else', async () => {
    const sink: AskSink = {};
    const registry = new ToolRegistry();
    registry.register(createAskManifest(sink));

    const tool = registry.lookup(ASK_TOOL);
    const result = await tool?.execute(
      { question: '  What time tonight?  ' },
      { timezone: 'UTC' } as never,
    );

    expect(sink.asked).toEqual({ question: 'What time tonight?', options: [], allowOther: true });
    // It delivers nothing and authorizes nothing: the return value is a receipt.
    expect(result).toEqual({ pending: true });
  });

  it('records quick choices and a recommendation without turning them into permission', async () => {
    const sink: AskSink = {};
    const registry = new ToolRegistry();
    registry.register(createAskManifest(sink));
    await registry.lookup(ASK_TOOL)?.execute(
      {
        question: 'Which account?',
        options: [
          { label: 'Checking', hint: 'Best match', recommended: true },
          { label: 'Savings' },
        ],
        allowOther: true,
      },
      { timezone: 'UTC' } as never,
    );
    expect(sink.asked).toMatchObject({
      question: 'Which account?',
      allowOther: true,
      options: [
        { label: 'Checking', hint: 'Best match', recommended: true },
        { label: 'Savings', hint: null, recommended: false },
      ],
    });
  });

  it('hands a provider an object schema, like every other tool this build ships', () => {
    const registry = new ToolRegistry();
    registry.register(createAskManifest({}));
    const spec = registry.list().find((s) => s.name === ASK_TOOL);
    expect(spec?.inputSchema).toMatchObject({ type: 'object' });
    expect(spec?.inputSchema.anyOf).toBeUndefined();
  });

  it('outranks the text rule: a declared question with no question mark still counts', () => {
    expect(endedWithQuestion('Tell me which card to use.')).toBe(false);
    expect(turnAskedOwner(true, 'Tell me which card to use.')).toBe(true);
  });

  it('is not a denial when it is absent — the text rule still applies', () => {
    expect(turnAskedOwner(false, 'What time tonight should I set that for?')).toBe(true);
    expect(turnAskedOwner(undefined, 'Done. The reminder is set for 7pm.')).toBe(false);
  });
});

describe('endedWithQuestion — the conservative text fallback', () => {
  it('fires on the question that caused the bug', () => {
    expect(
      endedWithQuestion('What time tonight should I set that for — 8pm, 9pm, something else?'),
    ).toBe(true);
  });

  it('fires on a short second-person question at the end of a longer answer', () => {
    expect(
      endedWithQuestion(
        'I can move both sites. EVT is on a 2GB plan and favortrans on a 1GB one.\n\nDo you want them on the same Hetzner box?',
      ),
    ).toBe(true);
  });

  it('does not fire on a question the agent went on to answer itself', () => {
    expect(
      endedWithQuestion(
        'Is it worth moving? Yes — Hetzner is about a third of the price. I have started the transfer.',
      ),
    ).toBe(false);
  });

  it('does not fire on a question inside a quoted email', () => {
    expect(
      endedWithQuestion('The message from Cloudways reads:\n\n> Do you want to keep this plan?'),
    ).toBe(false);
    expect(endedWithQuestion('He wrote back:\n\n"Can you do it by Friday?"')).toBe(false);
  });

  it('does not fire on a question inside a code block', () => {
    expect(endedWithQuestion('Here is the query:\n\n```sql\nselect 1; -- ready?\n```')).toBe(false);
  });

  it('does not fire on a rhetorical aside with no second person', () => {
    expect(endedWithQuestion('The bank has not posted it yet. Typical, no?')).toBe(false);
    expect(
      endedWithQuestion('Nothing has moved since Tuesday. Whether they ever will is anyone’s guess?'),
    ).toBe(false);
  });

  it('does not fire on a paragraph that merely ends in a question mark', () => {
    const long = `${'The projection holds through the end of the month and nothing is due before then, '.repeat(3)}so is that fine?`;
    expect(long.length).toBeGreaterThan(200);
    expect(endedWithQuestion(long)).toBe(false);
  });

  it('does not fire on an imperative clarification — that is the tool’s job', () => {
    expect(endedWithQuestion('Tell me which card to use.')).toBe(false);
  });
});

describe('answerVerdict — what escapes the capture', () => {
  it('reads a bare answer as an answer', () => {
    for (const text of ['7pm', 'Is good', 'yes', 'the second one', '8pm works, thanks']) {
      expect(answerVerdict(text), text).toBe('none');
    }
  });

  it('lets a slash command through to the active agent, always', () => {
    expect(answerVerdict('/status')).toBe('command');
    expect(answerVerdict('/use ledger')).toBe('command');
  });

  it('lets a mention of a third agent through, always', () => {
    expect(answerVerdict('@ledger can I afford it?')).toBe('mention');
  });

  it('lets a plainly fresh request through', () => {
    expect(answerVerdict('remind me to call the bank tomorrow')).toBe('fresh-request');
    expect(answerVerdict('send the invoice to Marc')).toBe('fresh-request');
    expect(answerVerdict('can you check the DNS on favortrans')).toBe('fresh-request');
  });

  it('lets a whole briefing through — an answer to one question is short', () => {
    expect(answerVerdict('x'.repeat(MAX_ANSWER_CHARS + 1))).toBe('too-long');
  });

  it('keeps an answer that is itself a question', () => {
    // The owner answering "what do you suggest?" is still answering.
    expect(answerVerdict('what do you suggest?')).toBe('none');
  });
});

describe('PendingQuestions — the claim and its bounds', () => {
  it('captures the next message, then releases the chat', () => {
    const pending = new PendingQuestions();
    pending.open('chat', QUESTION);

    const first = pending.claim('chat', '7pm', 2_000);
    expect(first.pending?.askedAgentId).toBe('concierge');
    pending.settle('chat', first.pending as PendingQuestion, false, 2_000);

    expect(pending.peek('chat')).toBeUndefined();
    expect(pending.claim('chat', 'Is good', 3_000).pending).toBeUndefined();
  });

  it('renews only while the agent keeps asking, and only three times', () => {
    const pending = new PendingQuestions();
    pending.open('chat', QUESTION);
    for (let i = 1; i <= 3; i++) {
      const taken = pending.claim('chat', 'ok', 2_000);
      expect(taken.pending?.captures, `capture ${i}`).toBe(i);
      pending.settle('chat', taken.pending as PendingQuestion, true, 2_000);
    }
    // The third capture spent it: a fourth question does not hold the chat.
    expect(pending.peek('chat')).toBeUndefined();
  });

  it('expires after fifteen minutes, however soon the next message is', () => {
    const pending = new PendingQuestions();
    pending.open('chat', QUESTION);
    const stale = pending.claim('chat', '7pm', QUESTION.at + PENDING_TTL_MS + 1);
    expect(stale.pending).toBeUndefined();
    expect(stale.pending === undefined && stale.reason).toBe('expired');
  });

  it('holds right up to the bound', () => {
    const pending = new PendingQuestions();
    pending.open('chat', QUESTION);
    expect(pending.claim('chat', '7pm', QUESTION.at + PENDING_TTL_MS).pending).toBeDefined();
  });

  it('dies on the first message that is not an answer, rather than waiting', () => {
    const pending = new PendingQuestions();
    pending.open('chat', QUESTION);
    expect(pending.claim('chat', '/status', 2_000).pending).toBeUndefined();
    // And it is gone: a later "7pm" is not retro-captured.
    expect(pending.claim('chat', '7pm', 3_000).pending).toBeUndefined();
  });

  it('is cleared outright when the owner switches agent', () => {
    const pending = new PendingQuestions();
    pending.open('chat', QUESTION);
    pending.clear('chat');
    expect(pending.claim('chat', '7pm', 2_000).pending).toBeUndefined();
  });

  it('keeps chats apart', () => {
    const pending = new PendingQuestions();
    pending.open('a', QUESTION);
    expect(pending.claim('b', '7pm', 2_000).pending).toBeUndefined();
    expect(pending.claim('a', '7pm', 2_000).pending).toBeDefined();
  });
});

describe('the line the owner reads', () => {
  it('names who answered and where the chat is now', () => {
    const taken: PendingQuestion = { ...QUESTION, captures: 1 };
    expect(capturedNote(taken, { stillAsking: false })).toBe(
      '(Concierge asked that, so your answer went there; you are back with Postman now.)',
    );
    expect(capturedNote(taken, { stillAsking: true })).toContain('still waiting on you');
    expect(capturedNote(taken, { stillAsking: true })).toContain('Postman is next');
  });
});
