/**
 * Which folder is Sent — the question this build has to get right without ever
 * opening a mailbox. Pure, so it is answered here rather than in production.
 */
import { describe, expect, it } from 'vitest';
import { GMAIL_SENT, leafOf, planFolders, sentConfidence, sentFolderOf } from './folders.js';
import type { MailboxInfo } from './ports.js';

function box(name: string, specialUse: string | null = null, flags: string[] = []): MailboxInfo {
  return { name, specialUse, flags };
}

describe('recognising the Sent folder', () => {
  it('believes the server first', () => {
    expect(sentConfidence(box('Éléments envoyés', '\\Sent'))).toBe(2);
    // The same answer when it arrives among the flags rather than as the
    // special-use attribute; both spellings are in the wild.
    expect(sentConfidence(box('Whatever', null, ['\\HasNoChildren', '\\Sent']))).toBe(2);
  });

  it('knows Gmail\'s path and the names providers actually use', () => {
    expect(sentConfidence(box(GMAIL_SENT))).toBe(1);
    expect(sentConfidence(box('Sent Items'))).toBe(1);
    expect(sentConfidence(box('INBOX.Sent'))).toBe(1);
    expect(sentConfidence(box('Gesendet'))).toBe(1);
    expect(sentConfidence(box('Archive'))).toBe(0);
  });

  it('never guesses Outbox is Sent — it can hold mail still queued or that failed to send', () => {
    expect(sentConfidence(box('Outbox'))).toBe(0);
    expect(sentConfidence(box('INBOX.Outbox'))).toBe(0);
  });

  it('takes the last segment of a path, whatever separator the server uses', () => {
    expect(leafOf('INBOX.Sent')).toBe('sent');
    expect(leafOf('[Gmail]/Sent Mail')).toBe('sent mail');
  });
});

describe('planning what to sync', () => {
  const listing = [
    box('INBOX'),
    box('[Gmail]/All Mail', '\\All'),
    box('[Gmail]/Sent Mail', '\\Sent'),
    box('[Gmail]/Trash', '\\Trash'),
    box('Projects'),
  ];

  it('marks the inbox and Sent synced, and records everything else', () => {
    const plan = planFolders(listing);
    expect(plan.map((f) => [f.name, f.kind, f.synced])).toEqual([
      ['INBOX', 'inbox', true],
      ['[Gmail]/All Mail', 'other', false],
      ['[Gmail]/Sent Mail', 'sent', true],
      ['[Gmail]/Trash', 'other', false],
      ['Projects', 'other', false],
    ]);
  });

  it('picks exactly one Sent folder, the better-evidenced one', () => {
    // A folder merely *called* Sent loses to the one the server labelled.
    const both = [box('INBOX'), box('Sent'), box('Envoyés', '\\Sent')];
    expect(sentFolderOf(both)).toBe('Envoyés');
    expect(planFolders(both).filter((f) => f.kind === 'sent')).toHaveLength(1);
  });

  it('says there is none rather than guessing', () => {
    expect(sentFolderOf([box('INBOX'), box('Archive'), box('Spam')])).toBeNull();
  });
});
