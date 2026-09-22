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
  discriminatingName,
  findAmount,
  findPromise,
  findQuestion,
  firstLines,
  fold,
  nameKey,
  ownText,
  GENERIC_NAMES,
  MAX_AMOUNT,
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

  it('sorts the tokens, so a corporate directory name is the same name', () => {
    // `MEYER, Jean-Paul` is how half the world's address books write it, and
    // it used to be a different person from `Jean-Paul Meyer`.
    expect(nameKey('MEYER, Jean-Paul')).toBe(nameKey('Jean-Paul Meyer'));
    expect(nameKey("O'Neil, Ana")).toBe(nameKey('Ana O Neil'));
  });

  it('folds the letters no decomposition takes apart', () => {
    expect(nameKey('Søren Kjær')).toBe(nameKey('Soren Kjaer'));
    expect(nameKey('Straße')).toBe(nameKey('Strasse'));
    expect(nameKey('Łukasz')).toBe(nameKey('Lukasz'));
  });

  it('reads a homoglyph as the letter it is drawn as', () => {
    // Cyrillic а, е, о and р in "Ana Rios" — a different string in every
    // comparison a database makes, and the same name to the only reader that
    // matters.
    expect(nameKey('\u0410na Ri\u043es')).toBe(nameKey('Ana Rios'));
    expect(nameKey('\u0391na')).toBe(nameKey('Ana'));
  });

  it('reads decomposed text as the composed spelling', () => {
    // NFD is what a Mac types. Before NFC normalisation, `Reçu` typed this way
    // scored nothing at all and `Ríos` was two tokens.
    const nfd = 'Ri\u0301os';
    expect(nameKey(nfd)).toBe(nameKey('Ríos'));
    expect(classifyReceipt({ subject: 'Votre rec\u0327u', from: 'a@b.test', body: '' })).not.toBeNull();
  });

  it('refuses a display name that identifies nobody', () => {
    for (const generic of GENERIC_NAMES) expect(discriminatingName(generic)).toBe(false);
    expect(discriminatingName('Support')).toBe(false);
    expect(discriminatingName('SERVICE CLIENT')).toBe(false);
    expect(discriminatingName('')).toBe(false);
    expect(discriminatingName('Ana Rios')).toBe(true);
    expect(discriminatingName('Ana')).toBe(true);
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

  it('gives the header boost to the phrase that scored, not to another', () => {
    // `your order` is in the subject (0.4 + 0.2); `invoice` is in the body
    // (0.55, no boost). The stronger phrase wins and keeps its own score —
    // it used to borrow the weak phrase's subject boost and read 0.75.
    const hit = read('Your order has shipped', 'ship@shop.test', 'See the invoice attached.');
    expect(hit).toMatchObject({ phrase: 'invoice', confidence: 0.55 });
  });

  it('refuses an absurd number as an amount rather than as an error', () => {
    // `email.receipts.amount` is numeric(14,2); a longer run of digits is an
    // order number or a broken table, and storing it would throw — which,
    // under the transactional stamp, costs the message its whole reading.
    expect(findAmount(`Total €${MAX_AMOUNT + 1}`)).toBeNull();
    expect(findAmount('Total €99999999999999999999')).toBeNull();
    expect(findAmount('Total €12,00')).toMatchObject({ value: 12 });
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
    expect(classifyAsk('Please buy two gift cards.')).toMatchObject({
      kind: 'gift-card',
      urgent: false,
      confidence: 0.8,
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

  it('only counts urgency that is in the same sentence as the ask', () => {
    expect(classifyAsk('Please buy two gift cards immediately.')?.confidence).toBe(0.95);
    // The same words, with the insisting done about something else entirely.
    expect(
      classifyAsk('Please buy two gift cards.\nThe office move is happening immediately.')
        ?.confidence,
    ).toBe(0.8);
    expect(classifyAsk('Nouvelles coordonnées bancaires, virement urgent.')?.confidence).toBe(0.95);
  });

  /**
   * The three shapes of a real password-reset or verification mail.
   *
   * Every one of them used to score 0.85 and wake the owner — hourly, for a
   * week, in the one watcher an `ignore` policy may not silence — because
   * "reset your password" is in all of them and so is the boilerplate that
   * says "contact us immediately". A watcher that does that is switched off by
   * Tuesday, and then it protects nobody from anything.
   */
  const REAL_RESETS = [
    'You asked to reset your password. If this was not you, contact us immediately.',
    'We received a request to reset your password. The link expires within 24 hours.',
    'Please verify your account to finish signing up. Do it today.',
  ];
  it.each(REAL_RESETS)('leaves a real reset mail a notice at most: %j', (text) => {
    const reading = classifyAsk(text);
    expect(reading === null || reading.confidence <= 0.8).toBe(true);
  });

  it('wakes somebody when the message asks to be given the credential', () => {
    expect(
      classifyAsk('Send me your password urgently so I can unlock the account before the audit.'),
    ).toMatchObject({ kind: 'credentials', urgent: true, confidence: 0.85 });
    expect(classifyAsk('Reply with your password and I will sort it out.')?.confidence).toBe(0.6);
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

  it('does not read a URL as a question', () => {
    // `https://x.test/a?utm=1` used to score, and the fenced phrase the agent
    // was shown was `test/a?`.
    expect(findQuestion('Here are the figures.\nSee https://x.test/a?utm=1 for more.')).toBeNull();
    // The sentence is the sentence, URL and all — but it is the *sentence*,
    // not a fragment cut at the dot inside `x.test`.
    expect(findQuestion('Doc at https://x.test/a?utm=1 — anything missing?')?.phrase).toBe(
      'Doc at https://x.test/a?utm=1 — anything missing?',
    );
    expect(findQuestion('See https://x.test/a?utm=1.\nAnything missing?')?.phrase).toBe(
      'Anything missing?',
    );
  });

  it('reads a polite ask with no question mark, in either language', () => {
    expect(findQuestion('Let me know what you think.')?.phrase).toBe('Let me know');
    expect(findQuestion('Pourriez-vous confirmer le devis.')?.phrase).toBe('Pourriez-vous');
    expect(findQuestion('Merci de me renvoyer le contrat signé.')?.phrase).toBe(
      'Merci de me renvoyer',
    );
  });

  it('does not read a thank-you as a request', () => {
    // "Merci de votre commande" is what every receipt in the mailbox opens
    // with, and it asks nothing at all.
    expect(findQuestion('Merci de votre commande, voici le récapitulatif.')).toBeNull();
    expect(findQuestion('Merci de vos retours.')).toBeNull();
  });

  it('says nothing about a message that asks for nothing', () => {
    expect(findQuestion('Here are the figures for September. Thanks in advance.')).toBeNull();
    expect(findQuestion('Bonjour, voici le contrat signé.')).toBeNull();
  });

  it('does not count a question the other side asked, quoted back', () => {
    expect(findQuestion('Attached.\n> Could you send the contract?')).toBeNull();
  });
});
