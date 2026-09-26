/** The own-address rule and the mail's shape, without a database. */
import { describe, expect, it } from 'vitest';
import { assertOwnAddressOnly, selfBody, selfEnvelope } from './channel.js';
import type { AccountRecord, SmtpEnvelope } from './ports.js';

const account = { id: 'a1', address: 'owner@example.test', aliases: ['me@alias.test'] } as AccountRecord;

describe('selfEnvelope', () => {
  it('is from and to the account address, with nothing else', () => {
    const envelope = selfEnvelope(account, { id: 'n', kind: 'recap', urgency: 'now', title: 'Hi\nthere', text: ' Body ' });
    expect(envelope).toEqual({
      from: 'owner@example.test',
      to: ['owner@example.test'],
      cc: [],
      bcc: [],
      subject: 'buddi: Hi there',
      text: 'Body\n',
      inReplyTo: null,
      references: [],
    });
    expect(() => assertOwnAddressOnly(account, envelope)).not.toThrow();
  });

  it('lists offers as lines and adds the link when it is a URL', () => {
    expect(selfBody({
      id: 'n', kind: 'recap', urgency: 'now', title: 'T', text: 'x',
      link: { route: '#/a', url: 'https://b.test/#/a' }, offers: [{ label: 'Do it' }],
    })).toBe('x\n\nhttps://b.test/#/a\n\n- Do it\nReply on the dashboard to act.\n');
  });
});

describe('assertOwnAddressOnly', () => {
  const good = selfEnvelope(account, { id: 'n', kind: 'recap', urgency: 'now', title: 'T' });
  const bad: Array<Partial<SmtpEnvelope>> = [
    { to: ['eve@evil.test'] },
    { to: ['owner@example.test', 'eve@evil.test'] },
    { cc: ['eve@evil.test'] },
    { bcc: ['owner@example.test'] },
    { to: ['me@alias.test'] },
    { from: 'eve@evil.test' },
    { to: [] },
  ];
  for (const change of bad) {
    it(`refuses ${JSON.stringify(change)}`, () => {
      expect(() => assertOwnAddressOnly(account, { ...good, ...change })).toThrow(/own address and nowhere else/);
    });
  }
});
