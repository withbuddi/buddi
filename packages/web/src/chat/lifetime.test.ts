/**
 * What the freed header space says.
 *
 * The property worth protecting is that it only speaks when it is certainly
 * true. "Your next message starts a fresh one" is a fact about a conversation
 * that has already crossed a limit; a *prediction* that it is about to would be
 * wrong often enough to become the noise the owner learns to skip, which is the
 * same failure the badge rules avoid.
 */
import { describe, expect, it } from 'vitest';
import { conversationLine, hasRolledOver, spanText } from './lifetime';
import type { ChatLifetime } from './types';

const NOW = Date.parse('2026-09-15T12:00:00Z');

const limits = { idleTimeoutMs: 3 * 3_600_000, maxChars: 80_000 };

const live = (over: Partial<ChatLifetime> = {}): ChatLifetime => ({
  messages: 12,
  lastActivityAt: '2026-09-15T11:40:00Z',
  chars: 4_000,
  ...limits,
  ...over,
});

describe('the conversation line', () => {
  it('says a conversation is new when nothing has been said in it', () => {
    const line = conversationLine({ lifetime: null, startedAt: null, now: NOW, timezone: 'UTC' });
    expect(line.text).toBe('New conversation');
    expect(line.tone).toBe('quiet');

    const empty = conversationLine({
      lifetime: live({ messages: 0, lastActivityAt: null }),
      startedAt: '2026-09-15T11:00:00Z',
      now: NOW,
      timezone: 'UTC',
    });
    expect(empty.text).toBe('New conversation');
  });

  it('counts the thread and says when it started', () => {
    const line = conversationLine({
      lifetime: live(),
      startedAt: '2026-09-15T09:32:00Z',
      now: NOW,
      timezone: 'UTC',
    });
    // Relative, because the question the owner is asking is how old this
    // thread is against the rule — not what o'clock it began.
    expect(line.text).toBe('12 messages · started 2 hours ago');
    expect(line.tone).toBe('quiet');
    // The rule itself is available on hover, with the installation's own
    // numbers rather than any written here.
    expect(line.title).toMatch(/^Started /);
    expect(line.title).toContain('3 hours idle');
    expect(line.title).toContain('80k characters');
    expect(line.title).toContain('carries over');
  });

  it('warns only once a limit is actually crossed', () => {
    // Two hours fifty idle: close, and still the same conversation. Saying
    // otherwise would be a guess.
    expect(hasRolledOver(live({ lastActivityAt: '2026-09-15T09:10:00Z' }), NOW)).toBe(false);

    const idle = conversationLine({
      lifetime: live({ lastActivityAt: '2026-09-15T08:30:00Z' }),
      startedAt: '2026-09-15T07:00:00Z',
      now: NOW,
      timezone: 'UTC',
    });
    expect(idle.text).toBe('12 messages · your next message starts a fresh one');
    expect(idle.tone).toBe('note');

    const long = conversationLine({
      lifetime: live({ chars: 90_000 }),
      startedAt: '2026-09-15T11:00:00Z',
      now: NOW,
      timezone: 'UTC',
    });
    expect(long.tone).toBe('note');
  });

  it('never calls an empty conversation expired, however old the row is', () => {
    expect(hasRolledOver(live({ messages: 0, lastActivityAt: null }), NOW)).toBe(false);
  });

  it('renders the limit in the coarsest honest unit', () => {
    expect(spanText(3 * 3_600_000)).toBe('3 hours');
    expect(spanText(3_600_000)).toBe('1 hour');
    expect(spanText(90 * 60_000)).toBe('90 minutes');
  });
});
