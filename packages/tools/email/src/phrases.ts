/**
 * The pinned phrase tables the four step-6 watchers read, and nothing else.
 *
 * docs/specs/email.md §7 asks four questions of a message's own words: did the
 * owner promise to come back to somebody, is this a receipt, is somebody asking
 * for a password or a wire, and did the owner ask a question nobody answered.
 * Every one of them is a *judgement over text*, so it lives here: a string in,
 * a small record out, no database, no clock, no model — which is what makes the
 * whole of it a table test (`phrases.test.ts`), the split docs/plugins.md §2.3
 * asks for.
 *
 * ## Why tables and not cleverness
 *
 * A watcher that guesses is worse than no watcher: it wakes the owner about
 * nothing until he switches it off, and then it protects him from nothing at
 * all. So every phrase below is one somebody actually writes, in English or in
 * French — the owner's mail is bilingual and a rule that only fires in English
 * would be half a rule — and the list is deliberately short. What is *not* in
 * it is the more important half, and each table says what it leaves out and
 * why.
 *
 * ## Folding, and why the phrase comes back in the sender's own words
 *
 * Matching is done on a **folded** copy of the text: lowercased, curly
 * apostrophes straightened, accents stripped, so `Reçu`, `RECU` and `reçu` are
 * one phrase rather than three table rows. The fold is built character by
 * character precisely so it is the same length as the original, which is what
 * lets a match report the words **as the sender typed them** — the owner
 * checking us reads his correspondent, not our normalisation. Those words are
 * sender-controlled and reach a model, so every caller fences them (`quoted`).
 *
 * ## Quoted history is not the message
 *
 * A line beginning with `>` is somebody else's mail, quoted back. A promise in
 * it was made in its own message; a question in it was already asked. Every
 * reader here drops those lines first, exactly as `dates.ts` does.
 */

/* ------------------------------------------------------------------ *
 * Folding
 * ------------------------------------------------------------------ */

const COMBINING = /[̀-ͯ]/g;

/**
 * One character, folded — and folded to **one character** or not at all.
 *
 * The length rule is the whole trick. `fold` has to be index-preserving so a
 * match found in the folded copy can be sliced out of the original, and a
 * character whose lowercase or decomposition is longer than itself (Turkish
 * dotted I, a ligature) is left exactly as it was rather than quietly shifting
 * every phrase after it by one.
 */
function foldChar(raw: string): string {
  const ch = raw === '’' || raw === 'ʼ' ? "'" : raw;
  const stripped = ch.normalize('NFD').replace(COMBINING, '');
  const base = stripped.length === ch.length ? stripped : ch;
  const lower = base.toLowerCase();
  return lower.length === base.length ? lower : base;
}

/** A copy of `text` that matches case-, accent- and apostrophe-insensitively. */
export function fold(text: string): string {
  let out = '';
  for (const ch of text) out += foldChar(ch);
  return out;
}

/**
 * The same fold, collapsed to a comparison key: whitespace and punctuation out.
 *
 * This is what `email.suspicious-sender` compares two display names with, so
 * `Jean-Paul Meyer`, `jean paul meyer` and `MEYER, Jean-Paul` are one name.
 * The SQL side of that test has the same function (`email.name_key`), and the
 * two are held to the same answers by `phrases.test.ts` and the DB suite.
 */
export function nameKey(text: string): string {
  return fold(text)
    .replace(/["'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The lines of a message that are its own: quoted history dropped. */
export function ownLines(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'));
}

/** The message's own text, quoted history dropped. */
export function ownText(text: string | null | undefined): string {
  return ownLines(text).join('\n');
}

/** The first `n` non-empty own lines, which is what a classifier reads. */
export function firstLines(text: string | null | undefined, n: number): string {
  return ownLines(text)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, n)
    .join('\n');
}

/** A hit: the words that fired, exactly as they were written. */
export interface PhraseHit {
  phrase: string;
}

/** Find the first of these patterns in `text`, and slice the original for it. */
function firstMatch(text: string, patterns: readonly RegExp[]): PhraseHit | null {
  const folded = fold(text);
  let best: { index: number; length: number } | null = null;
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const match = re.exec(folded);
    if (match === null) continue;
    if (best === null || match.index < best.index) {
      best = { index: match.index, length: match[0].length };
    }
  }
  if (best === null) return null;
  return { phrase: text.slice(best.index, best.index + best.length).trim() };
}

/* ------------------------------------------------------------------ *
 * 1. Promises — `email.promised-reply`
 * ------------------------------------------------------------------ */

/**
 * The sentences that mean "I owe you an answer", English and French.
 *
 * Short on purpose. Each one is a *commitment in the first person with a verb
 * of sending or returning*, which is the only shape that makes the owner's
 * silence afterwards a thing worth telling him about.
 *
 * Deliberately absent:
 *
 *  - **"let me check"**, "I'll have a look", "je regarde" — an intention, not a
 *    promise of a reply, and they end half the mails anybody writes;
 *  - **"thanks, I'll do that"** — the promise is to do something, and whether
 *    it was done is not readable from a mailbox;
 *  - **anything in the second or third person** ("he'll get back to you"): the
 *    reply is somebody else's to send.
 *
 * The apostrophe is folded, so `I'll`, `I’ll` and `ill` — no: `ill` does not
 * match, the pattern requires the apostrophe. `I will` is spelled out beside
 * each contraction rather than made optional, because `i'?ll` would also match
 * `ill`.
 */
export const PROMISE_PATTERNS: readonly RegExp[] = [
  /\bi'll get back to you\b/u,
  /\bi will get back to you\b/u,
  /\bi'll come back to you\b/u,
  /\bi will come back to you\b/u,
  /\bi'll send\b/u,
  /\bi will send\b/u,
  /\bi'll follow up\b/u,
  /\bi will follow up\b/u,
  /\bi'll let you know\b/u,
  /\bi will let you know\b/u,
  /\bi'll revert\b/u,
  /\bi will revert\b/u,
  /\bje reviens vers (?:vous|toi)\b/u,
  /\bje vous reviens\b/u,
  /\bje te reviens\b/u,
  /\bje vous envoie\b/u,
  /\bje t'envoie\b/u,
  /\bje vous tiens au courant\b/u,
  /\bje te tiens au courant\b/u,
  /\bje vous fais un retour\b/u,
];

/** The promise in this message, in the owner's own words, or null. */
export function findPromise(text: string | null | undefined): PhraseHit | null {
  return firstMatch(ownText(text), PROMISE_PATTERNS);
}

/* ------------------------------------------------------------------ *
 * 2. Receipts and bills — `email.receipt-or-bill`
 * ------------------------------------------------------------------ */

/** What a phrase found in the subject or the sender adds. */
export const RECEIPT_HEADER_BOOST = 0.2;

/** What an amount beside the word "total" adds. */
export const RECEIPT_AMOUNT_BOOST = 0.2;

/** Nothing is certain: this is evidence for an agent, not a fact. */
export const MAX_RECEIPT_CONFIDENCE = 0.95;

/**
 * The words a receipt uses, with what each is worth on its own.
 *
 * The strong row is the vocabulary of a document that records a payment:
 * nobody writes `facture` or `payment received` about anything else. The weak
 * row is the vocabulary of *commerce* — an order number, an amount due — which
 * is a shipping notice as often as a receipt, and needs the subject line or an
 * amount beside it to clear the owner's threshold.
 *
 * Deliberately absent: bare **"bill"** (a person, a duck, a proposal in
 * parliament) — `your bill` and `facture` carry it; bare **"payment"** and
 * **"paiement"**, which are the subject of every dunning letter and half of
 * marketing; **"order"** alone, for the same reason as "bill".
 */
export const RECEIPT_PHRASES: ReadonlyArray<{ re: RegExp; weight: number }> = [
  { re: /\binvoices?\b/u, weight: 0.55 },
  { re: /\bfactures?\b/u, weight: 0.55 },
  { re: /\breceipts?\b/u, weight: 0.55 },
  { re: /\brecus?\b/u, weight: 0.55 },
  { re: /\bquittances?\b/u, weight: 0.55 },
  { re: /\border confirmation\b/u, weight: 0.55 },
  { re: /\bconfirmation de (?:votre )?commande\b/u, weight: 0.55 },
  { re: /\bpayment received\b/u, weight: 0.55 },
  { re: /\bpaiement recu\b/u, weight: 0.55 },
  { re: /\byour bill\b/u, weight: 0.55 },
  { re: /\byour order\b/u, weight: 0.4 },
  { re: /\bvotre commande\b/u, weight: 0.4 },
  { re: /\bamount due\b/u, weight: 0.4 },
  { re: /\bmontant du\b/u, weight: 0.4 },
  { re: /\btotal due\b/u, weight: 0.4 },
  { re: /\border (?:#|no\.?|number)\s*\d/u, weight: 0.4 },
  { re: /\bcommande n(?:o|°|º)?\.?\s*\d/u, weight: 0.4 },
];

/** The three currencies this reads. A symbol it does not know is not an amount. */
export const CURRENCIES: ReadonlyArray<{ re: RegExp; code: 'EUR' | 'USD' | 'GBP' }> = [
  { re: /€|\beur\b/u, code: 'EUR' },
  { re: /\$|\busd\b/u, code: 'USD' },
  { re: /£|\bgbp\b/u, code: 'GBP' },
];

/** How far from the word "total" an amount still counts as that total. */
export const TOTAL_WINDOW = 40;

const TOTAL_WORD = /\b(?:total|montant|amount due|balance|net a payer|a payer)\b/giu;
/**
 * A number the way both continents write one: `1 234,56`, `1,299.99`, `45,00`.
 *
 * The thousands mark has to be read *inside* the number rather than left to end
 * it, or `$1,299.99` comes back as one euro twenty-nine — the kind of quiet
 * wrongness a finding would then state as a fact, in the owner's own ledger.
 */
const NUMBER = String.raw`\d+(?:[.,   ]\d{3})*(?:[.,]\d{1,2})?`;
const SIGN = String.raw`(?:€|\$|£|\beur\b|\busd\b|\bgbp\b)`;
const AMOUNT = new RegExp(`${SIGN}\\s*(${NUMBER})|(${NUMBER})\\s*${SIGN}`, 'iu');

/** An amount as this file reports it: a number and a code, never a string. */
export interface Amount {
  value: number;
  currency: 'EUR' | 'USD' | 'GBP';
  /** The words it was read from, for the detail. Sender-controlled: fence it. */
  phrase: string;
}

/** `1 234,56` and `1,234.56` are the same number written by two continents. */
function amountValue(raw: string): number | null {
  const bare = raw.replace(/[  \s]/g, '');
  // The last separator, when there are two digits after it, is the decimal
  // one; everything else is a thousands mark. `1.234` is a thousand, not one.
  const match = /^(.*?)([.,](\d{1,2}))?$/u.exec(bare);
  if (match === null) return null;
  const whole = (match[1] ?? '').replace(/[.,]/g, '');
  const cents = match[3] ?? '';
  if (whole === '' || !/^\d+$/u.test(whole)) return null;
  const value = Number(cents === '' ? whole : `${whole}.${cents}`);
  return Number.isFinite(value) ? value : null;
}

/**
 * The total this text states, when it states one beside the word for it.
 *
 * "Beside" is `TOTAL_WINDOW` characters, either side: invoices put the amount
 * after the label and receipts put it in a right-hand column that flattens to
 * the same line. A currency amount with no such word near it is not read at
 * all — every marketing mail carries a price.
 */
export function findAmount(text: string): Amount | null {
  const folded = fold(text);
  TOTAL_WORD.lastIndex = 0;
  for (let word = TOTAL_WORD.exec(folded); word !== null; word = TOTAL_WORD.exec(folded)) {
    const from = Math.max(0, word.index - TOTAL_WINDOW);
    const to = Math.min(folded.length, word.index + word[0].length + TOTAL_WINDOW);
    const window = folded.slice(from, to);
    const hit = AMOUNT.exec(window);
    if (hit === null) continue;
    const value = amountValue(hit[1] ?? hit[2] ?? '');
    if (value === null) continue;
    const currency = CURRENCIES.find((c) => new RegExp(c.re.source, 'iu').test(hit[0]));
    if (currency === undefined) continue;
    const at = from + hit.index;
    return { value, currency: currency.code, phrase: text.slice(at, at + hit[0].length).trim() };
  }
  return null;
}

/** What the classifier was given, already bounded by its caller. */
export interface ReceiptInput {
  subject: string;
  from: string;
  /** The first lines of the body — see `firstLines`. */
  body: string;
}

export interface ReceiptReading {
  /** 0–0.95. `receiptConfidence` is where a finding starts. */
  confidence: number;
  /** The words that fired, as they were written. Sender-controlled. */
  phrase: string;
  amount: Amount | null;
}

/** Two decimals, the way `numeric(3,2)` will store it. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Is this a receipt, an invoice or an order confirmation?
 *
 * The strongest phrase anywhere sets the floor; the subject or the sender
 * saying it, and a total beside a currency sign, each add a fifth. Nothing
 * below one phrase scores at all — a message with no receipt vocabulary in it
 * is not a receipt however many euros it mentions.
 */
export function classifyReceipt(input: ReceiptInput): ReceiptReading | null {
  const header = `${input.subject}\n${input.from}`;
  const whole = `${header}\n${input.body}`;
  const foldedHeader = fold(header);
  let best: { weight: number; phrase: string } | null = null;
  let inHeader = false;
  for (const { re, weight } of RECEIPT_PHRASES) {
    const hit = firstMatch(whole, [re]);
    if (hit === null) continue;
    if (best === null || weight > best.weight) best = { weight, phrase: hit.phrase };
    if (new RegExp(re.source, 'iu').test(foldedHeader)) inHeader = true;
  }
  if (best === null) return null;
  const amount = findAmount(whole);
  const confidence = Math.min(
    MAX_RECEIPT_CONFIDENCE,
    round2(best.weight + (inHeader ? RECEIPT_HEADER_BOOST : 0) + (amount ? RECEIPT_AMOUNT_BOOST : 0)),
  );
  return { confidence, phrase: best.phrase, amount };
}

/* ------------------------------------------------------------------ *
 * 3. The ask — `email.suspicious-sender`, test (b)
 * ------------------------------------------------------------------ */

/** What this file calls the three things a fraud asks for. */
export type AskKind = 'credentials' | 'wire' | 'gift-card';

/** What "urgently" adds to any of them. §7's *«a password reset "urgently"»*. */
export const URGENCY_BOOST = 0.25;

export const MAX_ASK_CONFIDENCE = 0.95;

/**
 * The three asks, with what each is worth before urgency.
 *
 * The order is the order of how little else they could mean. Nobody legitimate
 * asks by mail for a gift card; a wire instruction arriving unasked is at
 * least unusual; a password prompt is the shape every real service's mail also
 * has, so it starts lowest and needs the urgency to wake anybody.
 *
 * Deliberately absent: **"click here"**, **"verify"** on its own, **"account"**
 * — they are in every newsletter footer, and a watcher that cried at them would
 * be off by Tuesday.
 */
export const ASK_PATTERNS: ReadonlyArray<{ kind: AskKind; weight: number; re: RegExp }> = [
  { kind: 'gift-card', weight: 0.8, re: /\bgift cards?\b/u },
  { kind: 'gift-card', weight: 0.8, re: /\bcartes? cadeaux?\b/u },
  { kind: 'gift-card', weight: 0.8, re: /\b(?:itunes|google play|amazon) cards?\b/u },
  { kind: 'wire', weight: 0.7, re: /\bwire transfer\b/u },
  { kind: 'wire', weight: 0.7, re: /\bbank transfer\b/u },
  { kind: 'wire', weight: 0.7, re: /\bvirement (?:bancaire|urgent|immediat)\b/u },
  { kind: 'wire', weight: 0.7, re: /\bchange (?:of|our) bank (?:details|account)\b/u },
  { kind: 'wire', weight: 0.7, re: /\bnouvelles? coordonnees bancaires\b/u },
  { kind: 'wire', weight: 0.7, re: /\bnouvel iban\b/u },
  { kind: 'credentials', weight: 0.6, re: /\b(?:confirm|verify|update) your password\b/u },
  { kind: 'credentials', weight: 0.6, re: /\breset your password\b/u },
  { kind: 'credentials', weight: 0.6, re: /\bsend (?:me |us )?your password\b/u },
  { kind: 'credentials', weight: 0.6, re: /\bverify your (?:account|identity|credentials)\b/u },
  { kind: 'credentials', weight: 0.6, re: /\bvotre mot de passe\b/u },
  { kind: 'credentials', weight: 0.6, re: /\bidentifiants? de connexion\b/u },
  { kind: 'credentials', weight: 0.6, re: /\bverifiez votre compte\b/u },
];

/** The words that turn any of the three into an emergency. */
export const URGENCY = /\b(?:urgent(?:ly|e|es)?|immediately|immediatement|right away|within 24 hours|sous 24 ?h|dans les 24 heures|au plus vite|as soon as possible|asap|today|aujourd'hui)\b/u;

export interface AskReading {
  kind: AskKind;
  /** 0–0.95. Above 0.8 wakes somebody; §7. */
  confidence: number;
  phrase: string;
  urgent: boolean;
}

/**
 * Does this message ask for a credential, a wire or a gift card?
 *
 * Read over the message's own lines only: a phishing mail quoted back into a
 * "look at this" forward is a conversation about a fraud, not one.
 */
export function classifyAsk(text: string | null | undefined): AskReading | null {
  const own = ownText(text);
  if (own.trim() === '') return null;
  const folded = fold(own);
  let best: { kind: AskKind; weight: number; phrase: string } | null = null;
  for (const { kind, weight, re } of ASK_PATTERNS) {
    const hit = firstMatch(own, [re]);
    if (hit === null) continue;
    if (best === null || weight > best.weight) best = { kind, weight, phrase: hit.phrase };
  }
  if (best === null) return null;
  const urgent = new RegExp(URGENCY.source, 'iu').test(folded);
  return {
    kind: best.kind,
    confidence: Math.min(MAX_ASK_CONFIDENCE, round2(best.weight + (urgent ? URGENCY_BOOST : 0))),
    phrase: best.phrase,
    urgent,
  };
}

/* ------------------------------------------------------------------ *
 * 4. Questions — `email.unanswered-by-them`
 * ------------------------------------------------------------------ */

/**
 * The phrases that make a message a request, beside the question mark itself.
 *
 * §7's nudge is about mail the owner is *waiting on*, and a message that asks
 * nothing is not one. A question mark is the strongest signal and needs no
 * table; these are the polite English and French ways of asking without one.
 *
 * Deliberately absent: **"thanks in advance"** and **"merci d'avance"** —
 * they close a request that is already in the message and would double-count,
 * and they also close half the messages that ask for nothing at all.
 */
export const QUESTION_PATTERNS: readonly RegExp[] = [
  /\blet me know\b/u,
  /\bcan you\b/u,
  /\bcould you\b/u,
  /\bwould you\b/u,
  /\bany (?:news|update)\b/u,
  /\bpourriez-?vous\b/u,
  /\bpouvez-?vous\b/u,
  /\bpeux-?tu\b/u,
  /\bmerci de\b/u,
  /\bdis-?moi\b/u,
  /\btiens-?moi au courant\b/u,
];

/** A sentence that ends in a question mark, if there is one. */
function questionSentence(text: string): PhraseHit | null {
  const folded = fold(text);
  const at = folded.indexOf('?');
  if (at < 0) return null;
  const start = Math.max(
    0,
    ...['.', '!', '?', '\n'].map((mark) => folded.lastIndexOf(mark, at - 1) + 1),
  );
  const phrase = text.slice(start, at + 1).trim();
  return phrase === '?' ? null : { phrase };
}

/** The question this message asks, in the owner's own words, or null. */
export function findQuestion(text: string | null | undefined): PhraseHit | null {
  const own = ownText(text);
  return questionSentence(own) ?? firstMatch(own, QUESTION_PATTERNS);
}
