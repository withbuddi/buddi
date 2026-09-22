/**
 * The watchers' judgements, without a database (docs/plugins.md §2.3).
 *
 * Severity is a rule and a key is an identity; both are pure functions here so
 * that the sentinel files stay a query and a call, and so a change of wording
 * cannot quietly change which fact is which.
 */
import { describe, expect, it } from 'vitest';
import {
  clampWaitingDays,
  dateFinding,
  dateKey,
  firstLineOf,
  severityForAge,
  waitingFinding,
  waitingKey,
  DEFAULT_WAITING_DAYS,
  MAX_WAITING_DAYS,
  MIN_WAITING_DAYS,
  WARNING_WAITING_DAYS,
  type StatedDate,
  type WaitingThread,
} from './watchers.js';

const THREAD: WaitingThread = {
  threadId: 't-1',
  subject: 'The lease',
  from: 'agent@letting.test',
  lastInboundId: 'm-9',
  ageDays: 3,
  firstLine: 'Could you confirm the date by the end of the week?',
};

describe('severity is a rule', () => {
  it('notices at two days and warns at a week', () => {
    expect(severityForAge(2)).toBe('info');
    expect(severityForAge(6)).toBe('info');
    expect(severityForAge(WARNING_WAITING_DAYS)).toBe('urgent');
    expect(severityForAge(30)).toBe('urgent');
  });
});

describe('the waiting-on-me finding', () => {
  it('names the sender, the age and the subject', () => {
    const finding = waitingFinding(THREAD);
    expect(finding.title).toBe('agent@letting.test has been waiting 3 days on "The lease"');
    expect(finding.severity).toBe('info');
    expect(finding.detail).toContain('Could you confirm the date');
    expect(finding.data.threadId).toBe('t-1');
    expect(finding.data.ageDays).toBe(3);
  });

  it('says "1 day" rather than "1 days"', () => {
    expect(waitingFinding({ ...THREAD, ageDays: 1 }).title).toContain('waiting 1 day on');
  });

  it('keys the fact to the thread and the message waiting in it', () => {
    expect(waitingFinding(THREAD).key).toBe(waitingKey('t-1', 'm-9'));
    // A reply arriving is a different fact, and core resolves the old one.
    expect(waitingKey('t-1', 'm-10')).not.toBe(waitingKey('t-1', 'm-9'));
  });

  it('survives a subject nobody wrote', () => {
    expect(waitingFinding({ ...THREAD, subject: '   ' }).title).toContain('"(no subject)"');
  });

  it('leaves the quote out when there is no text to quote', () => {
    const finding = waitingFinding({ ...THREAD, firstLine: '' });
    expect(finding.detail).not.toContain('begins');
  });
});

describe('the date-stated finding', () => {
  const hit: StatedDate = {
    messageId: 'm-4',
    threadId: 't-2',
    subject: 'Insurance renewal',
    from: 'billing@insurer.test',
    date: '2026-09-30',
    phrase: 'due 30 September',
    confidence: 0.8,
  };

  it('names the date and the subject, and offers a reminder', () => {
    const finding = dateFinding(hit);
    expect(finding.title).toBe('A date is stated: 2026-09-30, in "Insurance renewal"');
    expect(finding.detail).toContain('due 30 September');
    expect(finding.detail).toContain('reminder.set');
    expect(finding.data.suggestedAction).toBe('set-a-reminder');
  });

  it('is never urgent: a parse is evidence, not an alarm', () => {
    expect(dateFinding(hit).severity).toBe('info');
    expect(dateFinding({ ...hit, confidence: 0.95 }).severity).toBe('info');
  });

  it('keys the fact to the message and the day', () => {
    expect(dateFinding(hit).key).toBe(dateKey('m-4', '2026-09-30'));
    expect(dateKey('m-4', '2026-10-01')).not.toBe(dateKey('m-4', '2026-09-30'));
  });
});

describe('the first line of a message', () => {
  it('takes the first line that is neither blank nor quoted', () => {
    expect(firstLineOf('\n\n> old mail\nHello there\nmore')).toBe('Hello there');
  });

  it('bounds it', () => {
    expect(firstLineOf('x'.repeat(400))).toHaveLength(201);
    expect(firstLineOf('x'.repeat(400)).endsWith('…')).toBe(true);
  });

  it('answers empty for nothing at all', () => {
    expect(firstLineOf(null)).toBe('');
    expect(firstLineOf('> only quotes')).toBe('');
  });
});

describe('the waiting-days setting', () => {
  it('clamps into a range a watcher can mean something in', () => {
    expect(clampWaitingDays(0)).toBe(MIN_WAITING_DAYS);
    expect(clampWaitingDays(1000)).toBe(MAX_WAITING_DAYS);
    expect(clampWaitingDays(2.7)).toBe(2);
    expect(clampWaitingDays(Number.NaN)).toBe(DEFAULT_WAITING_DAYS);
  });
});
