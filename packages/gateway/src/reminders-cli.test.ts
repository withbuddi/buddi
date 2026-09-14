import { describe, expect, it } from 'vitest';
import { formatReminder, parseRemindersArgs } from './reminders-cli.js';

describe('parseRemindersArgs', () => {
  it('lists the pending ones by default', () => {
    expect(parseRemindersArgs([])).toEqual({ action: 'list', all: false });
  });

  it('narrows to one agent and widens to every state', () => {
    expect(parseRemindersArgs(['--agent', 'finance-advisor'])).toEqual({
      action: 'list',
      agentId: 'finance-advisor',
      all: false,
    });
    expect(parseRemindersArgs(['--all'])).toEqual({ action: 'list', all: true });
  });

  it('takes an id to cancel, and insists on one', () => {
    expect(parseRemindersArgs(['cancel', 'r-1'])).toEqual({ action: 'cancel', id: 'r-1' });
    expect(() => parseRemindersArgs(['cancel'])).toThrow(/needs a reminder id/);
  });

  it('refuses what it does not know rather than ignoring it', () => {
    expect(() => parseRemindersArgs(['--nope'])).toThrow(/unknown option/);
    expect(() => parseRemindersArgs(['--agent'])).toThrow(/needs an agent id/);
  });
});

describe('formatReminder', () => {
  it('leads with the id, because the id is what the owner types next', () => {
    const line = formatReminder(
      {
        id: 'r-1',
        agentId: 'finance-advisor',
        conversationId: null,
        dueAt: new Date('2026-09-20T13:00:00Z'),
        text: 'check the card payment',
        context: null,
        state: 'pending',
        createdAt: new Date('2026-09-14T12:00:00Z'),
        firedAt: null,
        cancelledAt: null,
        cancelReason: null,
      },
      'America/New_York',
    );
    expect(line.split('\n')[0]).toBe('r-1');
    expect(line).toContain('09:00');
    expect(line).toContain('finance-advisor');
    expect(line).toContain('check the card payment');
  });
});
