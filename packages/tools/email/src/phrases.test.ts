/**
 * The four phrase tables, pinned (docs/plugins.md §2.3, docs/specs/email.md §7).
 *
 * The whole judgement of step 6's watchers is in `phrases.ts`, so the whole
 * judgement is testable without a database — and the tables below are the
 * contract: what fires, what deliberately does not, and what each reading
 * scores. A change of wording that changes which mail wakes the owner has to
 * change a line here first.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyAsk,
  classifyReceipt,
  findAmount,
  findPromise,
  findQuestion,
  firstLines,
  fold,
  nameKey,
  ownText,
} from './phrases.js';

describe('folding', () => {
  it('keeps the length, so a match can be sliced out of the original', () => {
    for (const text of ['Reçu n°4', "I’ll send it", 'ÉCHÉANCE', 'straße', 'a b']) {
      expect(fold(text)).toHaveLength(text.length);
    }
  });

  it('makes case, accents and curly apostrophes one thing', () => {
    expect(fold('Reçu')).toBe('recu');
    expect(fold("I’ll")).toBe("i'll");
    expect(fold('ÉCHÉANCE')).toBe('echeance');
  });

  it('compares two display names the way a person does', () => {
    expect(nameKey('Jean-Paul MEYER')).toBe(nameKey('jean paul meyer'));
    expect(nameKey('"Ana Ríos"')).toBe('ana rios');
    expect(nameKey('  ')).toBe('');
    expect(nameKey('Ana Rios')).not.toBe(nameKey('Ana Riosa'));
  });

  it('drops quoted history before anything is read', () => {
    expect(ownText('Yes.\n> I will send it tomorrow\nThanks')).toBe('Yes.\nThanks');
    expect(firstLines('one\n\ntwo\nthree', 2)).toBe('one\ntwo');
  });
});

describe('promises — email.promised-reply', () => {
  const fires: Array<[string, string]> = [
    ["Thanks. I'll get back to you on Monday.", "I'll get back to you"],
    ['I will send the figures tonight.', 'I will send'],
    ["I’ll follow up with the numbers.", 'I’ll follow up'],
    ['Bien reçu, je reviens vers vous demain.', 'je reviens vers vous'],
    ['Je vous envoie le devis cette semaine.', 'Je vous envoie'],
    ['Je vous tiens au courant dès que possible.', 'Je vous tiens au courant'],
  ];
  it.each(fires)('reads %j as a promise', (text, phrase) => {
    expect(findPromise(text)?.phrase).toBe(phrase);
  });

  const silent = [
    // An intention, not a promise of a reply.
    'Let me check with the office.',
    'Je regarde ça.',
    // Somebody else's promise to send.
    'He will send it to you directly.',
    // The promise is in quoted history: it was made in its own message.
    "Noted.\n> I'll get back to you next week",
    '',
  ];
  it.each(silent)('says nothing about %j', (text) => {
    expect(findPromise(text)).toBeNull();
  });
});

describe('receipts — email.receipt-or-bill', () => {
  const read = (subject: string, from: string, body = '') =>
    classifyReceipt({ subject, from, body });

  it('scores an invoice in the subject with a total above the default threshold', () => {
    const hit = read('Invoice 2026-114', 'billing@insurer.test', 'Total: €120,50 due on 30/09');
    // 0.55 for "invoice", a fifth for the subject, a fifth for the total.
    expect(hit).toMatchObject({ confidence: 0.95, phrase: 'Invoice' });
    expect(hit?.amount).toEqual({ value: 120.5, currency: 'EUR', phrase: '€120,50' });
  });

  it('reads the French of the same thing', () => {
    const hit = read('Votre facture du mois', 'facturation@operateur.test', 'Montant : 45,00 €');
    expect(hit?.confidence).toBe(0.95);
    expect(hit?.amount).toEqual({ value: 45, currency: 'EUR', phrase: '45,00 €' });
  });

  it('leaves a shipping notice below the default threshold until it names a total', () => {
    // "your order" is commerce, not a receipt: 0.4 plus the subject is 0.6.
    expect(read('Your order has shipped', 'ship@shop.test')?.confidence).toBe(0.6);
    expect(
      read('Your order has shipped', 'ship@shop.test', 'Order total $31.00')?.confidence,
    ).toBe(0.8);
  });

  it('scores a receipt word found only in the body lower than one in the subject', () => {
    expect(read('Hello', 'someone@work.test', 'the receipt is attached')?.confidence).toBe(0.55);
  });

  it('says nothing about a message with no receipt vocabulary, whatever it costs', () => {
    expect(read('Weekend plans', 'friend@work.test', 'Dinner was €80 in total, split later')).toBeNull();
  });

  it('reads an amount only beside the word for it', () => {
    expect(findAmount('Total 1 234,56 €')).toMatchObject({ value: 1234.56, currency: 'EUR' });
    expect(findAmount('Amount due: $1,299.99')).toMatchObject({ value: 1299.99, currency: 'USD' });
    expect(findAmount('£20 off your next order')).toBeNull();
    // A currency it does not know is not an amount.
    expect(findAmount('Total 1200 CHF')).toBeNull();
  });
});

describe('the ask — email.suspicious-sender', () => {
  it('scores a gift card highest and a password prompt lowest', () => {
    expect(classifyAsk('Please buy two gift cards today.')).toMatchObject({
      kind: 'gift-card',
      urgent: true,
      confidence: 0.95,
    });
    expect(classifyAsk('We have a new IBAN, please use it for the wire transfer.')).toMatchObject({
      kind: 'wire',
      urgent: false,
      confidence: 0.7,
    });
    expect(classifyAsk('Click to reset your password.')).toMatchObject({
      kind: 'credentials',
      urgent: false,
      confidence: 0.6,
    });
  });

  it('is only urgent above 0.8, which is what the urgency word buys', () => {
    // 0.6 + 0.25 = 0.85, which is what makes §7's «a password reset "urgently"»
    // a thing that wakes somebody and a plain one a thing that does not.
    expect(classifyAsk('Reset your password immediately.')?.confidence).toBe(0.85);
    expect(classifyAsk('Nouvelles coordonnées bancaires, virement urgent.')?.confidence).toBe(0.95);
  });

  it('says nothing about the vocabulary of every newsletter', () => {
    expect(classifyAsk('Click here to see your account and verify the details.')).toBeNull();
    expect(classifyAsk('Your payment was received. Thank you.')).toBeNull();
  });

  it('does not read a fraud somebody forwarded as a fraud being committed', () => {
    expect(classifyAsk('Look at this one.\n> Please send me your password urgently')).toBeNull();
  });
});

describe('questions — email.unanswered-by-them', () => {
  it('takes the sentence the question mark ends', () => {
    expect(findQuestion('Hello. Could we meet on Thursday? Thanks.')?.phrase).toBe(
      'Could we meet on Thursday?',
    );
  });

  it('reads a polite ask with no question mark, in either language', () => {
    expect(findQuestion('Let me know what you think.')?.phrase).toBe('Let me know');
    expect(findQuestion('Pourriez-vous confirmer le devis.')?.phrase).toBe('Pourriez-vous');
    expect(findQuestion('Merci de me renvoyer le contrat signé.')?.phrase).toBe('Merci de');
  });

  it('says nothing about a message that asks for nothing', () => {
    expect(findQuestion('Here are the figures for September. Thanks in advance.')).toBeNull();
    expect(findQuestion('Bonjour, voici le contrat signé.')).toBeNull();
  });

  it('does not count a question the other side asked, quoted back', () => {
    expect(findQuestion('Attached.\n> Could you send the contract?')).toBeNull();
  });
});
