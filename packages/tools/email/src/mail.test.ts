import { describe, expect, it } from 'vitest';
import {
  isUnread,
  normalizeAddress,
  normalizeAddresses,
  normalizeMessageId,
  parseReferences,
  prepareForIngest,
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
    to: ['a@x.test'],
    cc: ['c@x.test'],
    bcc: ['secret@x.test'],
    subject: 'Re: Bill',
    bodyText: 'Paid.',
    bodySha256: sha256('Paid.'),
    attachments: [{ filename: 'r.pdf', mime: 'application/pdf', sizeBytes: 1, sha256: 'abcdef0123456789' }],
    inReplyTo: '<a@x>',
    references: ['<a@x>'],
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
});
