import { describe, expect, it } from 'vitest';
import { notificationTopic, sameTopic } from './topic.js';

// The four that reached Home on 2026-09-27, from two agents.
const AMEX = [
  { agentId: 'finance-advisor', title: 'Pay the Amex Blue Cash minimum, 40 USD, today…' },
  { agentId: 'mail-triage', title: 'Pay at least the 40.00 USD minimum on the Amex Blue Cash Everyday 92000 today…' },
  { agentId: 'mail-triage', title: 'Amex card ending 992000 (Blue Cash Everyday): payment is due today, Sept 27…' },
  { agentId: 'finance-advisor', title: 'Pay at least 40 USD on the Amex Blue Cash Everyday 92000 today. The minimum is due tomorrow…' },
];

describe('notification topics', () => {
  it('writes numbers plainly and leaves dates, weekdays and common words out', () => {
    expect(notificationTopic(AMEX[1]!)).toBe('pay 40 amex blue cash everyday 92000');
    expect(notificationTopic(AMEX[2]!)).toBe('amex 992000 blue cash everyday pay');
    expect(notificationTopic({ title: 'Dentist on 2026-10-02, Friday 3rd at 9/30' })).toBe('dentist');
  });

  it('folds the four Amex reminders into one, whichever came first', () => {
    const topics = AMEX.map(notificationTopic);
    for (const a of topics) for (const b of topics) expect(sameTopic(a, b)).toBe(true);
  });

  it('keeps different things apart, even about the same card', () => {
    const payment = notificationTopic(AMEX[0]!);
    const others = [
      'Pay the Chase Sapphire minimum, 35 USD, by Friday',
      'Amex Blue Cash: a new charge of 12 USD at Starbucks',
      'Your flight to Lisbon leaves tomorrow at 9',
      'Dentist appointment moved to Monday',
    ].map((title) => notificationTopic({ title }));
    for (const other of others) expect(sameTopic(payment, other)).toBe(false);
    expect(sameTopic(others[2], others[3])).toBe(false);
  });

  it('leaves the agent’s own name out and reads the text when the title names little', () => {
    expect(notificationTopic({ agentId: 'finance-advisor', title: 'Finance advisor: Amex update' })).toBe('amex');
    expect(notificationTopic({ title: 'Heads up', text: 'The Amex Blue Cash payment is due today.' }))
      .toBe('amex blue cash pay');
    expect(sameTopic('', 'amex blue cash')).toBe(false);
  });
});
