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

const COMBINING = /[\u0300-\u036f]/g;

/**
 * One character, folded — and folded to **one character** or not at all.
 *
 * The length rule is the whole trick. `fold` has to be index-preserving so a
 * match found in the folded copy can be sliced out of the original, and a
 * character whose lowercase or decomposition is longer than itself (Turkish
 * dotted I, a ligature) is left exactly as it was rather than quietly shifting
 * every phrase after it by one.
 *
 * Which is also why `fold` cannot handle **decomposed** text on its own: a
 * standalone combining acute is a character of its own, and dropping it would
 * move every phrase after it. So the text is put into NFC *first*, by `nfc`
 * below, and every entry point here does that before it folds — otherwise
 * `Votre reçu` typed on a Mac reads as `votre rec u` and matches nothing.
 */
function foldChar(raw: string): string {
  const ch = raw === '\u2019' || raw === '\u02bc' ? "'" : raw;
  const stripped = ch.normalize('NFD').replace(COMBINING, '');
  const base = stripped.length === ch.length ? stripped : ch;
  const lower = base.toLowerCase();
  return lower.length === base.length ? lower : base;
}

/**
 * Composed text. Every entry point normalises with this before it folds, and
 * the phrase a caller gets back is sliced out of *this* copy — so what the
 * owner is shown is the composed spelling of what the sender wrote.
 */
export function nfc(text: string): string {
  return text.normalize('NFC');
}

/** A copy of `text` that matches case-, accent- and apostrophe-insensitively. */
export function fold(text: string): string {
  let out = '';
  for (const ch of text) out += foldChar(ch);
  return out;
}

/* ---- the name key, and the one algorithm both sides implement ---- */

/**
 * Letters no decomposition will take apart, and what they are worth as ASCII.
 *
 * NFKD turns `é` into `e` plus a mark, but it does nothing at all to `ø`, `æ`
 * or `ß`: they are letters in their own right, not decorated ones. Without
 * this table `Søren Kjær` and `Soren Kjaer` are two different people, which is
 * a look-alike test that misses the Scandinavian half of a contact list.
 *
 * The expansions are two characters long, which is why the name key — unlike
 * `fold` — is not index-preserving. It never needs to be: nothing is sliced
 * out of it, it is only ever compared.
 */
export const LETTER_FOLDINGS: ReadonlyArray<[string, string]> = [
  ['\u00e6', 'ae'],
  ['\u0153', 'oe'],
  ['\u00df', 'ss'],
  ['\u00fe', 'th'],
  ['\u00f0', 'd'],
  ['\u00f8', 'o'],
  ['\u0111', 'd'],
  ['\u0142', 'l'],
  ['\u0131', 'i'],
];

/**
 * The homoglyphs, Cyrillic and Greek, mapped onto the Latin letter they are
 * drawn as.
 *
 * This is the whole of what makes the look-alike test worth running against
 * somebody who is *trying*: `Аna Rios` with a Cyrillic А is a different string
 * from `Ana Rios` in every comparison a database does by default, and it is
 * the same name to the only reader that matters. The table is pinned, short,
 * and one-directional — Latin is the target alphabet because the addresses
 * these names sit beside are ASCII.
 *
 * It is not a general confusables table and does not try to be: it is the
 * lowercase Cyrillic and Greek letters that are drawn like a Latin one, and
 * nothing else.
 */
export const CONFUSABLES: ReadonlyArray<[string, string]> = [
  // Cyrillic
  ['\u0430', 'a'], ['\u0432', 'b'], ['\u0435', 'e'], ['\u043a', 'k'], ['\u043c', 'm'],
  ['\u043d', 'h'], ['\u043e', 'o'], ['\u0440', 'p'], ['\u0441', 'c'], ['\u0442', 't'],
  ['\u0443', 'y'], ['\u0445', 'x'], ['\u0456', 'i'], ['\u0458', 'j'], ['\u0455', 's'],
  ['\u04bb', 'h'], ['\u0501', 'd'], ['\u051b', 'q'], ['\u0261', 'g'],
  // Greek
  ['\u03b1', 'a'], ['\u03b2', 'b'], ['\u03b5', 'e'], ['\u03b7', 'n'], ['\u03b9', 'i'],
  ['\u03ba', 'k'], ['\u03bd', 'v'], ['\u03bf', 'o'], ['\u03c1', 'p'], ['\u03c3', 'o'],
  ['\u03c4', 't'], ['\u03c5', 'u'], ['\u03c7', 'x'], ['\u03bc', 'u'], ['\u03b3', 'y'],
];

/**
 * Display names too generic to identify anybody.
 *
 * The look-alike test asks "is this a name the owner writes to, at another
 * address?". `Support` is a name the owner writes to at a dozen addresses, and
 * so are the rest of these — so every one of them would be an urgent warning
 * about the second shop he ever bought anything from. The list is of *name
 * keys*, so it is already normalised and token-sorted, and it is matched
 * whatever the token count: `Service Client` is two tokens and is no more a
 * person than `Support` is.
 */
export const GENERIC_NAMES: readonly string[] = [
  'admin',
  'billing',
  'client service',
  'contact',
  'hello',
  'hr',
  'info',
  'no reply',
  'notifications',
  'payments',
  'sales',
  'security',
  'support',
  'team',
];

/**
 * One display name, reduced to what two display names have in common or do not.
 *
 * The algorithm, in the order it runs — and `email.name_key` in migration
 * `011_receipts.sql` runs exactly the same one, which `step6.db.test.ts` pins
 * with a table of names asserted equal across the two:
 *
 *  1. **NFKD**, which takes `é` apart into `e` and a mark, and also folds the
 *     compatibility forms (a fullwidth `Ａ`, a ligature `ﬁ`) onto their
 *     ordinary letters;
 *  2. **drop the combining marks**, so the accent goes and the letter stays —
 *     removed, never replaced by a space, or `Ríos` becomes two tokens;
 *  3. **lowercase**, which also brings Cyrillic and Greek down to the case the
 *     tables below are written in;
 *  4. **the letter foldings and the confusables**, which are the two tables
 *     no decomposition will do for us;
 *  5. **everything that is not a letter or a digit becomes a space**, so
 *     apostrophes, hyphens, dots and commas stop being differences;
 *  6. **sort the tokens**, which is what makes `MEYER, Jean-Paul` and
 *     `Jean-Paul Meyer` one name — the comma-first form every corporate
 *     directory produces.
 *
 * Step 6 has a known and accepted cost: `May Lee` and `Lee May` are one name
 * here. Two real correspondents whose names are each other's reverse is rarer
 * than a corporate address book, and the two failures are not symmetric — the
 * collision costs a warning the agent reads the thread about, while dropping
 * the sort costs *silence* about the comma form, which is exactly the form an
 * impostor would copy. It is stated in docs/specs/email.md §7 as a limit.
 */
export function nameKey(text: string): string {
  let out = (text ?? '')
    .normalize('NFKD')
    .replace(COMBINING, '')
    .toLowerCase();
  for (const [from, to] of LETTER_FOLDINGS) out = out.split(from).join(to);
  for (const [from, to] of CONFUSABLES) out = out.split(from).join(to);
  return out
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '')
    .sort()
    .join(' ');
}

/**
 * Is this display name worth comparing at all?
 *
 * Empty is not a name — an impostor with no display name is imitating nothing.
 * Neither is one of `GENERIC_NAMES`. `email.discriminating_name` is the same
 * test in SQL, and the DB suite holds the two to the same answers.
 */
export function discriminatingName(text: string): boolean {
  const key = nameKey(text);
  return key !== '' && !GENERIC_NAMES.includes(key);
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

/**
 * Find the first of these patterns in `text`, and slice the composed copy.
 *
 * `at` is where the match started, which is what lets a caller ask a question
 * about the *sentence* the phrase sits in rather than about the whole message
 * — `classifyAsk` needs exactly that.
 */
function firstMatch(
  text: string,
  patterns: readonly RegExp[],
): (PhraseHit & { at: number; length: number }) | null {
  const source = nfc(text);
  const folded = fold(source);
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
  return {
    phrase: source.slice(best.index, best.index + best.length).trim(),
    at: best.index,
    length: best.length,
  };
}

/**
 * Where one sentence ends and the next begins.
 *
 * A full stop is only a full stop when something follows it that ends a word:
 * whitespace, a closing quote or bracket, or the end of the text. The `.` in
 * `x.test` and the `?` in `a?utm=1` are not sentence breaks, and treating them
 * as such is how a quoted "question the owner asked" came out as `test/a?`.
 */
const SENTENCE_BREAK = String.raw`[.!?](?=[\s"')\]]|$)|\n`;

/** The start of the sentence `at` falls in. */
function sentenceStart(folded: string, at: number): number {
  const re = new RegExp(SENTENCE_BREAK, 'gu');
  let start = 0;
  for (let m = re.exec(folded); m !== null && m.index < at; m = re.exec(folded)) {
    start = m.index + m[0].length;
  }
  return start;
}

/** The sentence `at` falls in, as a fold. */
function sentenceAround(folded: string, at: number): string {
  const re = new RegExp(SENTENCE_BREAK, 'gu');
  re.lastIndex = at;
  const end = re.exec(folded);
  return folded.slice(sentenceStart(folded, at), end === null ? folded.length : end.index + 1);
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

/**
 * The highest score the classifier will ever give: nothing is certain, and
 * this is evidence for an agent rather than a fact.
 *
 * Named a *ceiling* rather than a maximum because it is not the bound of the
 * owner's setting — it is the bound of what the classifier can produce, and
 * the two being one identifier is how `receiptConfidence` came to accept 0.96
 * and switch the watcher off without saying so. `watchers.ts` imports this one
 * as the setting's upper bound, so the two cannot drift apart again.
 */
export const RECEIPT_CONFIDENCE_CEILING = 0.95;

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

/**
 * The largest total this will report: `email.receipts.amount` is
 * `numeric(14,2)`, which is twelve digits before the point and two after.
 *
 * A string of digits longer than that is an order number, a VAT id or a
 * malformed table, not money — and reading it as money would make the *insert*
 * throw, which under the transactional stamp (see `receipts-store.ts`) costs
 * the whole message its reading. So an absurd number is "no amount", quietly,
 * which is what it is.
 */
export const MAX_AMOUNT = 999_999_999_999.99;

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
export function findAmount(raw: string): Amount | null {
  const text = nfc(raw);
  const folded = fold(text);
  TOTAL_WORD.lastIndex = 0;
  for (let word = TOTAL_WORD.exec(folded); word !== null; word = TOTAL_WORD.exec(folded)) {
    const from = Math.max(0, word.index - TOTAL_WINDOW);
    const to = Math.min(folded.length, word.index + word[0].length + TOTAL_WINDOW);
    const window = folded.slice(from, to);
    const hit = AMOUNT.exec(window);
    if (hit === null) continue;
    const value = amountValue(hit[1] ?? hit[2] ?? '');
    if (value === null || value > MAX_AMOUNT) continue;
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
  const header = nfc(`${input.subject}\n${input.from}`);
  const whole = `${header}\n${nfc(input.body)}`;
  const foldedHeader = fold(header);
  let best: { weight: number; phrase: string; inHeader: boolean } | null = null;
  for (const { re, weight } of RECEIPT_PHRASES) {
    const hit = firstMatch(whole, [re]);
    if (hit === null) continue;
    if (best !== null && weight <= best.weight) continue;
    /*
     * The boost belongs to the phrase that scored, not to any phrase.
     * Otherwise `your order` in a subject lends its fifth to `invoice` found
     * in the body, and a mail that merely mentions an invoice scores as one
     * announced in its own subject line.
     */
    best = { weight, phrase: hit.phrase, inHeader: new RegExp(re.source, 'iu').test(foldedHeader) };
  }
  if (best === null) return null;
  const amount = findAmount(whole);
  const confidence = Math.min(
    RECEIPT_CONFIDENCE_CEILING,
    round2(
      best.weight + (best.inHeader ? RECEIPT_HEADER_BOOST : 0) + (amount ? RECEIPT_AMOUNT_BOOST : 0),
    ),
  );
  return { confidence, phrase: best.phrase, amount };
}

/* ------------------------------------------------------------------ *
 * 3. The ask — `email.suspicious-sender`, test (b)
 * ------------------------------------------------------------------ */

/** What this file calls the three things a fraud asks for. */
export type AskKind = 'credentials' | 'wire' | 'gift-card';

/** What "urgently" adds — when it is in the same sentence as the ask. */
export const URGENCY_BOOST = 0.25;

export const MAX_ASK_CONFIDENCE = 0.95;

/**
 * The confidence an ask that does not actually ask for the thing is capped at.
 *
 * Equal to `ASK_URGENT_ABOVE` in `watchers.ts`, and severity is *strictly*
 * above that line, so a reading capped here is `info` by construction and no
 * arithmetic below can push it over.
 */
export const BOILERPLATE_CEILING = 0.8;

/**
 * The three asks, with what each is worth before urgency.
 *
 * The order is the order of how little else they could mean. Nobody legitimate
 * asks by mail for a gift card; a wire instruction arriving unasked is at
 * least unusual; a password prompt is the shape every real service's mail also
 * has.
 *
 * `demand` here marks the phrases that are a request **in themselves** —
 * "send me your password" is somebody asking, whatever surrounds it. The
 * nouns are not: `wire transfer` and `gift card` are the vocabulary of the
 * receipts and dispatch notices these very words arrive in, so whether *they*
 * are a demand is decided by `REQUEST_AROUND` below, in the noun's own
 * sentence.
 *
 * Deliberately absent: **"click here"**, **"verify"** on its own, **"account"**
 * — they are in every newsletter footer, and a watcher that cried at them would
 * be off by Tuesday.
 */
export const ASK_PATTERNS: ReadonlyArray<{
  kind: AskKind;
  weight: number;
  demand: boolean;
  re: RegExp;
}> = [
  { kind: 'gift-card', weight: 0.8, demand: false, re: /\bgift cards?\b/u },
  { kind: 'gift-card', weight: 0.8, demand: false, re: /\bcartes? cadeaux?\b/u },
  { kind: 'gift-card', weight: 0.8, demand: false, re: /\b(?:itunes|google play|amazon) cards?\b/u },
  { kind: 'wire', weight: 0.7, demand: false, re: /\bwire transfers?\b/u },
  { kind: 'wire', weight: 0.7, demand: false, re: /\bbank transfers?\b/u },
  { kind: 'wire', weight: 0.7, demand: false, re: /\bvirements? (?:bancaires?|urgents?|immediats?)\b/u },
  { kind: 'wire', weight: 0.7, demand: false, re: /\bchange (?:of|our) bank (?:details|account)\b/u },
  { kind: 'wire', weight: 0.7, demand: false, re: /\bnouvelles? coordonnees bancaires\b/u },
  { kind: 'wire', weight: 0.7, demand: false, re: /\bnouvel iban\b/u },
  // Somebody asking to be given the credential. This is the phishing half,
  // and these are requests in themselves rather than nouns.
  { kind: 'credentials', weight: 0.6, demand: true, re: /\bsend (?:me |us )?(?:your |the )?password\b/u },
  { kind: 'credentials', weight: 0.6, demand: true, re: /\breply with your (?:password|code|credentials)\b/u },
  { kind: 'credentials', weight: 0.6, demand: true, re: /\bshare your (?:password|credentials|login)\b/u },
  { kind: 'credentials', weight: 0.6, demand: true, re: /\benvoyez(?:-| )(?:moi|nous) votre mot de passe\b/u },
  // The vocabulary of every real reset mail. Named, not demanded: capped.
  { kind: 'credentials', weight: 0.6, demand: false, re: /\b(?:confirm|verify|update) your password\b/u },
  { kind: 'credentials', weight: 0.6, demand: false, re: /\breset your password\b/u },
  { kind: 'credentials', weight: 0.6, demand: false, re: /\bverify your (?:account|identity|credentials)\b/u },
  { kind: 'credentials', weight: 0.6, demand: false, re: /\bvotre mot de passe\b/u },
  { kind: 'credentials', weight: 0.6, demand: false, re: /\bidentifiants? de connexion\b/u },
  { kind: 'credentials', weight: 0.6, demand: false, re: /\bverifiez votre compte\b/u },
];

/**
 * Somebody asking for the thing, as opposed to telling you about it.
 *
 * This is the rule that separates *«Your wire transfer was processed»* — which
 * is a receipt, and which scored 0.95 and woke the owner urgently — from
 * *«please wire it to the new account today»*, which is the fraud. A noun is
 * never a demand on its own: it has to sit in a sentence that asks. Three
 * shapes, English and French:
 *
 *  - **a verb of giving or paying**: send, buy, purchase, transfer, wire, pay,
 *    forward, envoyer, acheter, virer, payer, régler, transférer, in any
 *    person or as an imperative;
 *  - **an asking construction**: can you, could you, would you, please,
 *    pourriez-vous, pouvez-vous, merci de, veuillez, j'ai besoin, I need;
 *  - **a direction**: `to`/`vers`/`sur` immediately after the noun, which is
 *    what a wiring *instruction* looks like when the verb is somewhere else.
 *
 * All three are tested against the **noun's own sentence**, the same slice
 * `URGENCY` is tested against, so a dispatch notice with a "please contact us"
 * three paragraphs down is still a dispatch notice.
 */
export const REQUEST_AROUND: readonly RegExp[] = [
  /\b(?:send|sends|sending|sent me|buy|buys|buying|purchase|purchases|purchasing|transfer|transfers|transferring|wire|wires|wiring|pay|pays|paying|forward|forwards|remit|remits)\b/u,
  /\b(?:envoyer|envoyez|envoie|acheter|achetez|achete|virer|virez|payer|payez|reglez|regler|transferer|transferez)\b/u,
  /\b(?:can you|could you|would you|please|kindly|i need you to|i need|we need you to)\b/u,
  /\b(?:pourriez-?vous|pouvez-?vous|merci de|veuillez|j'ai besoin)\b/u,
];

/**
 * `wire transfer **to** the new account` — an instruction with no verb of its
 * own. Only `to`, `vers` and `sur`: a bare `a` would read *«le virement a été
 * traité»* — the receipt — as an instruction, since the fold takes `à` to `a`.
 */
const DIRECTED_AT = /^\s*(?:to|vers|sur)\b/u;

/**
 * Is the sentence this noun sits in one that asks for it?
 *
 * **The noun is cut out of the sentence first**, and that is not a detail:
 * `wire transfer` contains `transfer` and `gift card` sits beside `card`, so a
 * search for a verb of paying over the whole sentence finds the noun's own
 * words and calls every dispatch notice a demand. What is left after the cut
 * is what somebody wrote *around* the thing.
 */
export function isRequest(sentence: string, nounStart: number, nounEnd: number): boolean {
  if (DIRECTED_AT.test(sentence.slice(nounEnd))) return true;
  const around = `${sentence.slice(0, nounStart)} ${sentence.slice(nounEnd)}`;
  return REQUEST_AROUND.some((re) => new RegExp(re.source, 'iu').test(around));
}

/**
 * The words that turn an ask into an emergency — **in its own sentence**.
 *
 * `today`, `aujourd'hui` and `asap` used to be here and are gone: they are not
 * emergency language in transactional mail, they are what a link's expiry is
 * written with. What is left is somebody insisting, and it only counts when it
 * insists about the thing being asked for, which is what the sentence test is.
 */
export const URGENCY = /\b(?:urgent(?:ly|e|es)?|immediately|immediatement|right away|within 24 hours|sous 24 ?h|dans les 24 heures|au plus vite|as soon as possible)\b/u;

export interface AskReading {
  kind: AskKind;
  /** 0–0.95. Above `ASK_URGENT_ABOVE` wakes somebody; §7. */
  confidence: number;
  phrase: string;
  urgent: boolean;
}

/**
 * Does this message ask for a credential, a wire or a gift card?
 *
 * Read over the message's own lines only: a phishing mail quoted back into a
 * "look at this" forward is a conversation about a fraud, not one.
 *
 * Two questions are asked of the sentence the phrase sits in, and neither of
 * the whole message: **is somebody asking for this** (`isRequest`), which is
 * what lets the reading pass `BOILERPLATE_CEILING` at all, and **is somebody
 * insisting** (`URGENCY`), which is what takes it over the urgent line. A
 * mention with neither is a notice, which is what a receipt should be.
 */
export function classifyAsk(text: string | null | undefined): AskReading | null {
  const own = nfc(ownText(text));
  if (own.trim() === '') return null;
  const folded = fold(own);
  let best: {
    kind: AskKind;
    weight: number;
    phrase: string;
    demand: boolean;
    at: number;
    length: number;
  } | null = null;
  for (const { kind, weight, demand, re } of ASK_PATTERNS) {
    const hit = firstMatch(own, [re]);
    if (hit === null) continue;
    if (best !== null && weight <= best.weight) continue;
    best = { kind, weight, phrase: hit.phrase, demand, at: hit.at, length: hit.length };
  }
  if (best === null) return null;

  const sentence = sentenceAround(folded, best.at);
  const nounStart = best.at - sentenceStart(folded, best.at);
  // A phrase that is a request in itself needs nothing around it; a noun does.
  const demanded =
    best.demand || isRequest(sentence, nounStart, nounStart + best.length);
  // The urgency has to be about *this*: in the sentence the ask is in, not
  // three paragraphs down in a signature or a link-expiry notice.
  const urgent = new RegExp(URGENCY.source, 'iu').test(sentence);
  const raw = round2(best.weight + (urgent ? URGENCY_BOOST : 0));
  const ceiling = demanded ? MAX_ASK_CONFIDENCE : BOILERPLATE_CEILING;
  return {
    kind: best.kind,
    confidence: Math.min(ceiling, raw),
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
 * `merci de` carries an infinitive: `merci de me renvoyer le contrat` is a
 * request and `merci de votre commande` is a thank-you, and without the verb
 * every receipt in the mailbox reads as a question the owner asked.
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
  /\bmerci de (?:bien vouloir |m'|me |nous |lui |leur )?[a-z]+er\b/u,
  /\bdis-?moi\b/u,
  /\btiens-?moi au courant\b/u,
];

/**
 * A sentence that really ends in a question mark.
 *
 * Three rules, and every one of them is a URL that used to read as a question
 * the owner asked — `https://x.test/a?utm=1` scored, and the fenced phrase the
 * agent was shown was `test/a?`:
 *
 *  - the `?` must be **preceded by a word character**, so `a?utm` is out only
 *    by the next rule but `(?)` and `??` are out here;
 *  - it must be **followed by whitespace, a closing mark, or the end** — a
 *    query string has more of the URL after it;
 *  - the **token it sits in** must not look like a URL or a parameter: no
 *    `://`, no `=`.
 *
 * And a rejected `?` does not end the search: a message can carry a link and
 * then ask something.
 */
function questionSentence(text: string): (PhraseHit & { at: number }) | null {
  const folded = fold(text);
  for (let at = folded.indexOf('?'); at >= 0; at = folded.indexOf('?', at + 1)) {
    const before = folded[at - 1] ?? '';
    const after = folded[at + 1] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before)) continue;
    if (after !== '' && !/[\s"')\]]/u.test(after)) continue;
    const start = sentenceStart(folded, at);
    const slice = folded.slice(start, at + 1);
    // The word the mark is attached to, to rule out a URL or a parameter.
    const token = slice.split(/\s+/).pop() ?? '';
    if (token.includes('://') || token.includes('=')) continue;
    const phrase = text.slice(start, at + 1).trim();
    if (phrase === '?') continue;
    return { phrase, at: start };
  }
  return null;
}

/** The question this message asks, in the owner's own words, or null. */
export function findQuestion(text: string | null | undefined): PhraseHit | null {
  const own = nfc(ownText(text));
  return questionSentence(own) ?? firstMatch(own, QUESTION_PATTERNS);
}
