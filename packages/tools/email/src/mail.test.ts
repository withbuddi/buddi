import { describe, expect, it } from 'vitest';
import {
  isSameMailbox,
  isUnread,
  looksUnreplyable,
  mailboxKey,
  normalizeAddress,
  normalizeAddresses,
  normalizeMessageId,
  parseReferences,
  prepareForIngest,
  replyRecipients,
  replySubject,
  snippetOf,
  threadKeyFor,
  triagePrompt,
} from './mail.js';
import { fakeMessage } from './imap/fake.js';
import { collectAttachments, findTextPart, parseHeaders } from './imap/imapflow-client.js';
import { renderPreview, sha256, type SendEnvelope } from './tools/send.js';

describe('addresses', () => {
  it('reduces a display-name address to the bare, lowercased one', () => {
    expect(normalizeAddress('Jane Doe <Jane@Example.COM>')).toBe('jane@example.com');
    expect(normalizeAddress('  plain@example.com ')).toBe('plain@example.com');
  });

  it('de-duplicates a recipient list without reordering it', () => {
    expect(normalizeAddresses(['B@x.test', 'a@x.test', '<b@x.test>'])).toEqual([
      'b@x.test',
      'a@x.test',
    ]);
  });
});

describe('message identity', () => {
  it('normalizes a Message-ID to its bracketed form', () => {
    expect(normalizeMessageId('abc@x.test')).toBe('<abc@x.test>');
    expect(normalizeMessageId(' <abc@x.test> ')).toBe('<abc@x.test>');
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });

  it('parses every reference in order', () => {
    expect(parseReferences('<a@x> <b@x>\r\n <c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(parseReferences(null)).toEqual([]);
  });

  it('threads on the root of the chain, then In-Reply-To, then itself', () => {
    expect(threadKeyFor({ messageId: '<c@x>', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'] })).toBe('<a@x>');
    expect(threadKeyFor({ messageId: '<c@x>', inReplyTo: '<b@x>', references: [] })).toBe('<b@x>');
    expect(threadKeyFor({ messageId: '<c@x>', inReplyTo: null, references: [] })).toBe('<c@x>');
    expect(threadKeyFor({ messageId: null, inReplyTo: null, references: [] })).toBeNull();
  });
});

describe('presentation', () => {
  it('collapses a snippet and caps it', () => {
    expect(snippetOf('  a\n\n b  ')).toBe('a b');
    expect(snippetOf('x'.repeat(500)).length).toBe(220);
  });

  it('prefixes Re: exactly once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Re:  Hello')).toBe('Re: Hello');
    expect(replySubject('   ')).toBe('Re:');
  });

  it('reads unread off the flags', () => {
    expect(isUnread([])).toBe(true);
    expect(isUnread(['\\Flagged'])).toBe(true);
    expect(isUnread(['\\seen'])).toBe(false);
  });
});

describe('triage prompt', () => {
  it('is a structured summary, and truncates a long body', () => {
    const prompt = triagePrompt({
      messageId: 'row-1',
      from: 'a@x.test',
      to: ['owner@x.test'],
      subject: 'Bill',
      date: '2026-09-13T00:00:00.000Z',
      hasAttachments: true,
      attachments: [{ filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 12 }],
      bodyText: 'y'.repeat(5000),
      bodyChars: 100,
    });
    expect(prompt).toContain('Message id (for the tools): row-1');
    expect(prompt).toContain('a.pdf (application/pdf, 12 bytes)');
    expect(prompt).toContain('truncated');
    expect(prompt.length).toBeLessThan(600);
  });

  it('carries the conversation: the state, the last turns quoted, the older ones a line each', () => {
    const turn = (n: number, direction: 'in' | 'out') => ({
      direction,
      from: direction === 'out' ? 'owner@x.test' : 'them@x.test',
      date: `2026-09-${String(n).padStart(2, '0')}T09:00:00.000Z`,
      subject: 'The quote',
      snippet: `line ${n}`,
      bodyText: `body ${n} `.repeat(200),
    });
    const prompt = triagePrompt({
      messageId: 'row-9',
      from: 'them@x.test',
      to: ['owner@x.test'],
      subject: 'Re: The quote',
      date: '2026-09-13T00:00:00.000Z',
      hasAttachments: false,
      attachments: [],
      bodyText: 'and again',
      thread: {
        id: 'thread-1',
        state: 'waiting-on-them',
        messageCount: 5,
        older: [turn(1, 'in'), turn(2, 'out')],
        recent: [turn(3, 'in'), turn(4, 'out')],
      },
      history: { replies: { count: 4, lastAt: '2026-09-12T00:00:00.000Z', averageHours: 26 } },
    });
    expect(prompt).toContain('of 5 messages, currently waiting-on-them');
    // The older ones are one line each, and say who wrote them.
    expect(prompt).toContain('- 2026-09-01 — them@x.test: line 1');
    expect(prompt).toContain('- 2026-09-02 — the owner (owner@x.test): line 2');
    // The recent ones are quoted, and bounded.
    expect(prompt).toContain('body 3');
    expect(prompt.split('[… truncated]')).toHaveLength(3);
    // The owner's habit, in words rather than in a number of seconds.
    expect(prompt).toContain('The owner has written back 4 times, usually within 26 hours');
  });
});

describe('prepareForIngest', () => {
  it('normalizes, snippets and threads in one pass', () => {
    const prepared = prepareForIngest({
      ...fakeMessage({
        from: 'Bank <Alerts@BANK.test>',
        to: ['Owner@X.test', 'owner@x.test'],
        messageId: 'c@x',
        inReplyTo: 'b@x',
        references: ['<a@x>', '<b@x>'],
        bodyText: 'one   two\nthree',
      }),
      uid: 7,
    });
    expect(prepared.from).toBe('alerts@bank.test');
    expect(prepared.to).toEqual(['owner@x.test']);
    expect(prepared.messageId).toBe('<c@x>');
    expect(prepared.threadKey).toBe('<a@x>');
    expect(prepared.snippet).toBe('one two three');
  });
});

describe('imap body structure', () => {
  it('prefers text/plain over text/html', () => {
    const structure = {
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/html', part: '1' },
        { type: 'text/plain', part: '2' },
      ],
    };
    expect(findTextPart(structure)).toEqual({ part: '2', type: 'text/plain' });
  });

  it('falls back to html, and to nothing at all', () => {
    expect(findTextPart({ type: 'multipart/mixed', childNodes: [{ type: 'text/html', part: '1' }] })).toEqual({
      part: '1',
      type: 'text/html',
    });
    expect(findTextPart({ type: 'application/pdf' })).toBeNull();
    expect(findTextPart(undefined)).toBeNull();
  });

  it('lists attachments without downloading them', () => {
    expect(
      collectAttachments({
        type: 'multipart/mixed',
        childNodes: [
          { type: 'text/plain', part: '1' },
          {
            type: 'application/pdf',
            part: '2',
            size: 4096,
            disposition: 'attachment',
            dispositionParameters: { filename: 'statement.pdf' },
          },
        ],
      }),
    ).toEqual([{ filename: 'statement.pdf', mime: 'application/pdf', sizeBytes: 4096 }]);
  });

  it('parses folded headers', () => {
    expect(parseHeaders('References: <a@x>\r\n <b@x>\r\nMessage-ID: <c@x>\r\n')).toEqual({
      references: '<a@x> <b@x>',
      'message-id': '<c@x>',
    });
  });
});

describe('send preview', () => {
  const envelope: SendEnvelope = {
    tool: 'email.send',
    toolVersion: '0.1.0',
    draftId: 'd1',
    accountAddress: 'owner@x.test',
    from: 'owner@x.test',
    fromChoices: ['owner@x.test'],
    to: ['a@x.test'],
    cc: ['c@x.test'],
    bcc: ['secret@x.test'],
    subject: 'Re: Bill',
    bodyText: 'Paid.',
    bodySha256: sha256('Paid.'),
    attachments: [{ filename: 'r.pdf', mime: 'application/pdf', sizeBytes: 1, sha256: 'abcdef0123456789' }],
    inReplyTo: '<a@x>',
    references: ['<a@x>'],
    replyAudience: { sender: 'a@x.test', beyondSender: ['c@x.test', 'secret@x.test'], widened: true },
    artifactId: 'art-1',
    createdByAgent: 'mail-triage',
  };

  it('shows every recipient, blind ones included, and the body hash', () => {
    const preview = renderPreview(envelope);
    expect(preview).toContain('Bcc:     secret@x.test');
    expect(preview).toContain('Cc:      c@x.test');
    expect(preview).toContain('In-Reply-To: <a@x>');
    expect(preview).toContain('r.pdf [abcdef012345]');
    expect(preview).toContain(sha256('Paid.'));
    expect(preview).toContain('recipients: 3 (bcc included)');
  });

  it('says "none" rather than leaving a recipient line blank', () => {
    expect(renderPreview({ ...envelope, bcc: [], cc: [], attachments: [] })).toContain('Bcc:     (none)');
  });

  it('names a widened audience as a widening, not as a longer list', () => {
    const preview = renderPreview(envelope);
    expect(preview).toContain('Audience: WIDER THAN A REPLY TO THE SENDER — 2 people beyond a@x.test');
    expect(preview).toContain('c@x.test, secret@x.test');
    // And it comes before the body, where the owner is still reading headers.
    expect(preview.indexOf('Audience:')).toBeLessThan(preview.indexOf('Paid.'));
  });

  it('says so plainly when a reply is the sender-only default', () => {
    const preview = renderPreview({
      ...envelope,
      cc: [],
      bcc: [],
      replyAudience: { sender: 'a@x.test', beyondSender: [], widened: false },
    });
    expect(preview).toContain('Audience: the sender alone — the default for a reply.');
  });

  it('says nothing about audience on a message that is not a reply', () => {
    expect(renderPreview({ ...envelope, replyAudience: null })).not.toContain('Audience:');
  });
});

describe('the owner\'s own addresses', () => {
  it('collapses case, plus-tags and Gmail\'s dots onto one mailbox', () => {
    expect(mailboxKey('Jane.Doe@Gmail.COM')).toBe('owner@example.com');
    expect(mailboxKey('janedoe+bills@gmail.com')).toBe('owner@example.com');
    expect(mailboxKey('jane.doe@googlemail.com')).toBe('owner@example.com');
    // Dots are Gmail's rule and nobody else's: elsewhere they are part of the
    // local part and two addresses that differ by one are two people.
    expect(mailboxKey('jean.dupont@example.test')).toBe('jean.dupont@example.test');
    expect(mailboxKey('jean.dupont+tag@example.test')).toBe('jean.dupont@example.test');
  });

  it('recognises the same mailbox however it is written', () => {
    expect(isSameMailbox('janedoe+x@gmail.com', 'Jane.Doe@googlemail.com')).toBe(true);
    expect(isSameMailbox('someone@example.test', 'someone.else@example.test')).toBe(false);
    expect(isSameMailbox('', 'someone@example.test')).toBe(false);
  });

  it('spots an address no human reads', () => {
    for (const address of [
      'no-reply@service.test',
      'noreply@service.test',
      'do_not_reply@service.test',
      'MAILER-DAEMON@service.test',
      'bounces+123@service.test',
      'notifications@service.test',
    ]) {
      expect(looksUnreplyable(address)).toBe(true);
    }
    expect(looksUnreplyable('dorothee@example.test')).toBe(false);
    expect(looksUnreplyable('replyto@example.test')).toBe(false);
  });
});

describe('who a reply goes to', () => {
  const original = {
    from: 'Dorothée <TDorothee22@Gmail.com>',
    to: ['owner@example.com', 'remy@example.test', 'noor@example.test'],
    cc: ['successor@example.test', 'Janedoe+bills@gmail.com'],
    owner: ['owner@example.com'],
  };

  it('goes to the sender alone when nothing is asked for', () => {
    const reply = replyRecipients(original);
    expect(reply).toMatchObject({
      to: ['tdorothee22@gmail.com'],
      cc: [],
      bcc: [],
      audience: 'sender',
      beyondSender: [],
    });
  });

  it('goes to the sender alone when the audience is named as the default', () => {
    expect(replyRecipients({ ...original, audience: 'sender' }).to).toEqual([
      'tdorothee22@gmail.com',
    ]);
  });

  it('keeps To in To and Cc in Cc when it is widened to everyone', () => {
    const reply = replyRecipients({ ...original, audience: 'everyone' });
    expect(reply.to).toEqual([
      'tdorothee22@gmail.com',
      'remy@example.test',
      'noor@example.test',
    ]);
    expect(reply.cc).toEqual(['successor@example.test']);
    expect(reply.beyondSender).toEqual([
      'remy@example.test',
      'noor@example.test',
      'successor@example.test',
    ]);
  });

  it("never puts the owner on a reply, in any form of his address", () => {
    const reply = replyRecipients({ ...original, audience: 'everyone' });
    const everyone = [...reply.to, ...reply.cc, ...reply.bcc];
    expect(everyone).not.toContain('owner@example.com');
    expect(everyone).not.toContain('Janedoe+bills@gmail.com');
    expect(everyone.some((a) => mailboxKey(a) === 'owner@example.com')).toBe(false);
    expect(reply.excludedOwn).toEqual(['owner@example.com', 'janedoe+bills@gmail.com']);
  });

  it('never carries a blind copy, whatever is asked for', () => {
    // There is no argument that puts one there, and the original's own blind
    // recipients are not stored — a bcc cannot be resurrected into a reply.
    expect(replyRecipients({ ...original, audience: 'everyone' }).bcc).toEqual([]);
    expect(Object.keys(replyRecipients(original))).not.toContain('blind');
  });

  it('de-duplicates, and keeps the stronger line', () => {
    const reply = replyRecipients({
      from: 'her@example.test',
      to: ['HER@example.test', 'him@example.test'],
      cc: ['him@example.test', 'third@example.test'],
      owner: ['owner@example.test'],
      audience: 'everyone',
    });
    expect(reply.to).toEqual(['her@example.test', 'him@example.test']);
    expect(reply.cc).toEqual(['third@example.test']);
  });

  it('adds named people without changing the shape', () => {
    const reply = replyRecipients({
      ...original,
      alsoTo: ['successor@example.test'],
      alsoCc: ['watcher@example.test', 'owner@example.com'],
    });
    expect(reply.to).toEqual(['tdorothee22@gmail.com', 'successor@example.test']);
    expect(reply.cc).toEqual(['watcher@example.test']);
    expect(reply.audience).toBe('sender');
    // Widening is a fact about who is on it, not about which argument was used.
    expect(reply.beyondSender).toEqual(['successor@example.test', 'watcher@example.test']);
  });

  it('has nobody to reply to when the owner is the only address on it', () => {
    const reply = replyRecipients({
      from: 'janedoe+self@gmail.com',
      to: ['owner@example.com'],
      owner: ['owner@example.com'],
      audience: 'everyone',
    });
    expect(reply.to).toEqual([]);
  });

  it('names who the wide shape would reach even when the narrow one was taken', () => {
    // The whole point: asking for `sender` must not hide the fact that four
    // other people read the message. This is the field a draft's result turns
    // into the owner's decision, so it is stated on both shapes.
    const narrow = replyRecipients(original);
    expect(narrow.audience).toBe('sender');
    expect(narrow.beyondSender).toEqual([]);
    expect(narrow.othersOnOriginal).toEqual([
      'remy@example.test',
      'noor@example.test',
      'successor@example.test',
    ]);
    expect(replyRecipients({ ...original, audience: 'everyone' }).othersOnOriginal).toEqual(
      narrow.othersOnOriginal,
    );
  });

  it('counts nobody twice, and never the owner or the sender, among the others', () => {
    const reply = replyRecipients({
      from: 'her@example.test',
      to: ['HER@example.test', 'janedoe+bills@gmail.com', 'him@example.test'],
      cc: ['him@example.test', 'jane.doe@googlemail.com'],
      owner: ['owner@example.com'],
    });
    expect(reply.othersOnOriginal).toEqual(['him@example.test']);
  });

  it('says there is no one else when the message was only between the two of them', () => {
    const reply = replyRecipients({
      from: 'her@example.test',
      to: ['owner@example.com'],
      owner: ['owner@example.com'],
    });
    expect(reply.othersOnOriginal).toEqual([]);
  });

  it('reports a sender that no human reads', () => {
    expect(
      replyRecipients({ from: 'no-reply@service.test', to: [], owner: ['owner@x.test'] })
        .senderLooksUnreplyable,
    ).toBe(true);
  });
});
