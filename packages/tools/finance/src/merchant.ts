/**
 * Merchant normalization and matching. Pure: no DB, no clock — the same two
 * descriptions always decide the same way, and the whole matching rule can be
 * tested without a database.
 *
 * A bank writes the same merchant a different way on every line: the pending
 * authorisation says `POS DEBIT CARD1234 LIDL #883`, the posted line two days
 * later says `LIDL SARL PARIS 11`, and the receipt says `Lidl`. Matching them
 * on the raw text is hopeless, so every description is reduced to a
 * `merchant_norm` — lowercase words only, with the transport noise removed —
 * and two rows are considered the same merchant when those strings are equal
 * or their word sets overlap enough.
 */

/** Noise words banks put in a description that say nothing about the merchant. */
const NOISE_WORDS = [
  'pos',
  'pin',
  'ach',
  'dbt',
  'dda',
  'debit',
  'credit',
  'purchase',
  'payment',
  'paiement',
  'txn',
  'trn',
  'ref',
];

const NOISE_RE = new RegExp(`\\b(?:${NOISE_WORDS.join('|')}|x{3,})\\b`, 'g');
const CARD_RE = /\b(?:card|carte)\s*\d+/g;

/**
 * `POS PURCHASE CARD1234 LIDL #883` → `lidl`.
 *
 * Lowercase, strip accents, drop a card number however it is glued on, drop
 * the noise words, then drop every digit and punctuation mark and collapse the
 * whitespace. The SQL backfill in migration 005 performs the same steps in the
 * same order; change one and change the other.
 */
export function normalizeMerchant(description: string): string {
  return description
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Apostrophes are deleted rather than blanked, so "Trader Joe's" and the
    // bank's "TRADER JOES" reduce to the same two words.
    .replace(/['‘’`]/g, '')
    .replace(CARD_RE, ' ')
    .replace(NOISE_RE, ' ')
    .replace(/[^a-z\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The word set of a normalized merchant, single letters dropped. */
export function merchantTokens(normalized: string): string[] {
  return [...new Set(normalized.split(' ').filter((t) => t.length > 1))];
}

/**
 * Share of the smaller word set that both descriptions have in common: 1 when
 * one is a subset of the other ('lidl' vs 'lidl sarl paris'), 0 when they are
 * disjoint. Deliberately not Jaccard — a bank that appends a city and a store
 * number should still match the receipt's bare merchant name.
 */
export function merchantOverlap(a: string, b: string): number {
  const left = merchantTokens(a);
  const right = merchantTokens(b);
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const shared = left.filter((t) => rightSet.has(t)).length;
  return shared / Math.min(left.length, right.length);
}

/** The overlap at which two different strings are taken to be one merchant. */
export const MERCHANT_OVERLAP_THRESHOLD = 0.6;

/** Same merchant: identical normalized text, or enough shared words. */
export function merchantMatches(a: string, b: string): boolean {
  if (a !== '' && a === b) return true;
  return merchantOverlap(a, b) >= MERCHANT_OVERLAP_THRESHOLD;
}

/** Cents tolerance: two amounts are "the same amount" within this. */
export const AMOUNT_TOLERANCE = 0.01;

/** Same money: same direction, same magnitude to the cent. */
export function amountMatches(a: number, b: number): boolean {
  return Math.sign(a) === Math.sign(b) && Math.abs(Math.abs(a) - Math.abs(b)) <= AMOUNT_TOLERANCE;
}

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function dayDelta(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The minimum a row needs to take part in matching. */
export interface MatchCandidate {
  id: string;
  occurredOn: string;
  amount: number;
  merchantNorm: string;
}

export interface MatchWindow {
  /** How many days BEFORE the reference date a candidate may sit. */
  daysBefore: number;
  /** How many days AFTER the reference date a candidate may sit. */
  daysAfter: number;
}

export interface MatchInput {
  occurredOn: string;
  amount: number;
  merchantNorm: string;
}

export interface Match<T extends MatchCandidate = MatchCandidate> {
  candidate: T;
  /** Days from the reference date to the candidate's date. */
  dayDelta: number;
  /** True when the normalized merchants are identical rather than merely close. */
  exactMerchant: boolean;
  overlap: number;
}

/**
 * The single best candidate for `target`, or undefined.
 *
 * A candidate qualifies on all three: the amount matches to the cent and in
 * the same direction, the date sits inside the window, and the merchant
 * matches. Among those that qualify, an exact merchant beats a fuzzy one, then
 * the nearest date wins, then the larger word overlap — so a pending charge
 * surrounded by three plausible postings takes the one it most likely became.
 */
export function bestMatch<T extends MatchCandidate>(
  target: MatchInput,
  candidates: readonly T[],
  window: MatchWindow,
): Match<T> | undefined {
  const scored: Match<T>[] = [];
  for (const candidate of candidates) {
    if (!amountMatches(target.amount, candidate.amount)) continue;
    const delta = dayDelta(target.occurredOn, candidate.occurredOn);
    if (delta < -window.daysBefore || delta > window.daysAfter) continue;
    const exact = target.merchantNorm !== '' && target.merchantNorm === candidate.merchantNorm;
    const overlap = merchantOverlap(target.merchantNorm, candidate.merchantNorm);
    if (!exact && overlap < MERCHANT_OVERLAP_THRESHOLD) continue;
    scored.push({ candidate, dayDelta: delta, exactMerchant: exact, overlap });
  }
  scored.sort((a, b) => {
    if (a.exactMerchant !== b.exactMerchant) return a.exactMerchant ? -1 : 1;
    const byDate = Math.abs(a.dayDelta) - Math.abs(b.dayDelta);
    if (byDate !== 0) return byDate;
    return b.overlap - a.overlap;
  });
  return scored[0];
}

/** Window a pending row looks through for the posted row that replaced it. */
export const SUPERSESSION_WINDOW: MatchWindow = { daysBefore: 0, daysAfter: 5 };

/** Window a receipt looks through for its charge — either side of the date. */
export const RECEIPT_WINDOW: MatchWindow = { daysBefore: 3, daysAfter: 3 };
