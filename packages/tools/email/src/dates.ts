/**
 * Dates stated in a message — the deterministic half of `email.date-stated`.
 *
 * docs/email.md §7: *«a message states a date within the next 14 days (a
 * deadline, an appointment, a due date), and no reminder exists for it»*. This
 * file finds the date. It is pure: a string and a reference instant in, a list
 * of `(day, phrase, confidence)` out, no database, no model, no clock of its
 * own — so the whole judgement is a table test.
 *
 * ## What it looks for, and what it deliberately does not
 *
 * Four shapes, English and French:
 *
 *  - ISO, `2026-09-22`. Unambiguous, so it starts highest.
 *  - a day beside a month name, in either order and in either language:
 *    `22 September`, `Sep 22`, `22 septembre`, `mardi 22 septembre`.
 *  - slashed numbers, `22/09` and `9/22`. **This is the ambiguous one** and it
 *    is treated as such: a number above twelve fixes its own role, and when
 *    both could be either the day-first reading is taken (the owner's mail is
 *    mostly French and the rest of the world writes day first) at a lower
 *    confidence, so a bare `9/8` never reaches the default threshold on its
 *    own and needs a "deadline" beside it to speak.
 *  - a weekday with a time: `Thursday at 3pm`, `jeudi à 15h`, `mardi 15:00`.
 *    Resolved against the message's own instant, which is why that instant is
 *    a parameter rather than "now": a mail read three days late still means
 *    the Thursday the sender meant.
 *
 * What it will not do, on purpose, because each one costs more false findings
 * than it buys true ones:
 *
 *  - **dotted numbers** (`22.09`) — indistinguishable from a version, a price
 *    or a section number in the kind of mail that carries all three;
 *  - **a bare weekday with no time** (`see you Thursday`) — real, but so
 *    common in sign-offs and idioms that it would raise a finding a week;
 *  - **relative words** (`tomorrow`, `in three days`, `next month`) — they need
 *    the sender's own timezone to mean a day, and the header that would give it
 *    is the one thing in a message nobody can trust;
 *  - **times without a day**, and anything beyond `DATE_HORIZON_DAYS`.
 *
 * The *fortnight* is not this file's rule. A message is read once, at ingest,
 * and every date it resolves inside the horizon is kept; whether a stored date
 * is close enough to be worth a finding is asked later, of the owner's clock,
 * by `statedDatesBetween`.
 *
 * ## Quoted history is not the message
 *
 * A line beginning with `>` is the mail somebody else wrote, quoted back. The
 * dates in it were already stated, in their own message, which this plugin has
 * very likely already read — so they are skipped entirely. Ingest cost is the
 * other half of that: a reply carrying a decade of quoted thread is mostly
 * lines this file never looks at.
 */

/** How far ahead a stated date is still worth a finding. §7's "next 14 days". */
export const DATE_WINDOW_DAYS = 14;

/**
 * How far ahead a date is still *stored*, which is not the same question.
 *
 * The fortnight is the alerting window and it belongs to the sentinel
 * (`statedDatesBetween`), not to the parser. The parser reads a message once,
 * at ingest, and stamps it — so a window measured from the message's own day
 * would silently throw away every date the owner has not reached yet: a
 * renewal announced two months out, or a backlog message swept up at catch-up
 * whose date is now three days away. Anything resolvable inside a year is
 * kept; beyond that it is nonsense or a lease, and neither is a reminder.
 */
export const DATE_HORIZON_DAYS = 365;

/** Confidence at or above which a hit is worth waking somebody about. */
export const DEFAULT_DATE_CONFIDENCE = 0.6;

/** The floor and ceiling the setting is clamped to. */
export const MIN_DATE_CONFIDENCE = 0.1;
export const MAX_DATE_CONFIDENCE = 0.99;

/** What a keyword in the same sentence adds. */
export const KEYWORD_BOOST = 0.3;

/** Nothing is ever certain: a hit is evidence for an agent, not a fact. */
export const MAX_CONFIDENCE = 0.95;

/** The base confidence of each shape, before any boost. */
export const BASE_CONFIDENCE = {
  iso: 0.6,
  monthName: 0.5,
  /** `22/09` where one of the numbers can only be a day. */
  numeric: 0.45,
  /** `9/8`, where either reading is possible. */
  numericAmbiguous: 0.3,
  weekdayTime: 0.4,
} as const;

/**
 * The words that turn a date into a commitment.
 *
 * §7 asks for "due"/"deadline"/"expires"/"appointment"/"rendez-vous" *within
 * the same sentence*; the French of the same five is here too, because the
 * owner's mail is bilingual and a rule that only fires in English would make
 * `échéance` a second-class deadline.
 */
const KEYWORDS =
  /\b(?:due|deadline|expir(?:e|es|ed|ing|y|ation)|appointment|rendez-?vous|echeance|date limite|avant le|au plus tard|renouvellement|renew(?:s|al)?)\b|échéances?/iu;

const MONTHS_EN: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const MONTHS_FR: Record<string, number> = {
  janvier: 1, janv: 1,
  'février': 2, fevrier: 2, 'févr': 2, fevr: 2, fev: 2, 'fév': 2,
  mars: 3,
  avril: 4, avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7, juil: 7,
  'août': 8, aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  'décembre': 12, decembre: 12, 'déc': 12,
};

const MONTHS: Record<string, number> = { ...MONTHS_EN, ...MONTHS_FR };

/** Monday is 1, Sunday is 7 — ISO, so the arithmetic below needs no table. */
const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1, lundi: 1,
  tuesday: 2, tue: 2, tues: 2, mardi: 2,
  wednesday: 3, wed: 3, mercredi: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, jeudi: 4,
  friday: 5, fri: 5, vendredi: 5,
  saturday: 6, sat: 6, samedi: 6,
  sunday: 7, sun: 7, dimanche: 7,
};

function alternatives(keys: readonly string[]): string {
  // Longest first: `sept` must win over `sep`, `septembre` over `sept`.
  return [...keys].sort((a, b) => b.length - a.length).join('|');
}

const MONTH_ALT = alternatives(Object.keys(MONTHS));
const WEEKDAY_ALT = alternatives(Object.keys(WEEKDAYS));

/* The four shapes. Each carries its own capture layout; see `scanSentence`. */
const ISO_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/gu;
const DAY_MONTH_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(?:de\\s+)?(${MONTH_ALT})\\.?(?:\\s+(\\d{4}))?\\b`,
  'giu',
);
const MONTH_DAY_RE = new RegExp(
  `\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  'giu',
);
const NUMERIC_RE = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/gu;
const WEEKDAY_TIME_RE = new RegExp(
  `\\b(${WEEKDAY_ALT})\\b[\\s,]*(?:at|à|a|vers|@)?\\s*(\\d{1,2})\\s*(?::(\\d{2})|(h)(\\d{2})?)?\\s*(am|pm)?`,
  'giu',
);

/** One date a message states, as this file reports it. */
export interface DateHit {
  /** The day, `YYYY-MM-DD`, in the owner's zone. */
  date: string;
  /** The words it was read from, for the owner to check us against. */
  phrase: string;
  /** 0–0.95. `DEFAULT_DATE_CONFIDENCE` is where a finding starts. */
  confidence: number;
}

export interface FindDatesOptions {
  /**
   * The message's own instant — IMAP INTERNALDATE, `fetched_at` when the
   * server gave none. Never the sender's `Date` header: a forged one would
   * move every relative reading in the message.
   */
  at: Date;
  /** The owner's zone, for turning that instant into a day. */
  timezone?: string;
  /**
   * How far ahead to keep a date, from the message's own day. Defaults to
   * `DATE_HORIZON_DAYS`; the fortnight that decides whether a stored date is
   * worth saying anything about is applied by the sentinel, not here.
   */
  windowDays?: number;
}

/* ------------------------------------------------------------------ *
 * Civil dates: strings and integers, never a local Date
 * ------------------------------------------------------------------ */

function dayString(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

/** Days since the epoch for a civil date. The only arithmetic clock here. */
function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dayNumberOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return dayNumber(y as number, m as number, d as number);
}

function isoOf(dayNo: number): string {
  const date = new Date(dayNo * 86_400_000);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Is this a day that exists? `31 February` is a typo, not a deadline. */
function realDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * How far a year-less date may be rolled into the next year to make it future.
 *
 * "2 January" written in September is next January and means it; "15 September"
 * written a week *after* the fifteenth is somebody talking about a day that has
 * gone by, not booking the same day in twelve months' time. The line between
 * the two is distance, and half a year is where it sits: past that, a rolled
 * reading is refused rather than stored and raised eleven months later.
 */
export const YEAR_ROLL_DAYS = 180;

/**
 * The year a month-and-day with no year means.
 *
 * The one the message was written in, unless that day has already gone by —
 * then the next one, as long as it is inside `YEAR_ROLL_DAYS`.
 */
function resolveYear(month: number, day: number, refDay: number, refYear: number): number | null {
  for (const year of [refYear, refYear + 1]) {
    if (!realDay(year, month, day)) continue;
    const dayNo = dayNumber(year, month, day);
    if (dayNo < refDay) continue;
    return year === refYear || dayNo <= refDay + YEAR_ROLL_DAYS ? year : null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

type Candidate = { dayNo: number; phrase: string; base: number; at: number };

/**
 * Strip the quoted history. A line whose first non-space character is `>` was
 * written by somebody else, in a message of its own.
 */
export function withoutQuotedLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

/**
 * Sentences, roughly — the unit a keyword has to share with a date.
 *
 * "Roughly" is honest: a sentence boundary in mail is a newline as often as a
 * full stop, and `Sep. 22` must not be cut in half by the abbreviation's own
 * dot. So a break is a newline, or a `.`/`!`/`?` followed by whitespace and
 * something that is not a digit — which leaves `22/09. Deadline:` in one piece
 * and costs nothing either way, since the keyword only ever adds confidence.
 */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[^\d\s])/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * The clauses inside one of those "sentences", with where each one starts.
 *
 * `sentencesOf` deliberately does not break on a full stop followed by a digit
 * — that is what keeps `Sep. 22` in one piece — but the cost is that "The
 * deadline has passed. 22/09 was the invoice number." arrives as a single
 * sentence, and the keyword would lend its confidence to a date in the next
 * breath. So the keyword is looked for in the clause the date is actually in:
 * every `.`/`!`/`?` is a boundary here, digits included.
 */
function clausesOf(sentence: string): Array<{ at: number; text: string }> {
  const clauses: Array<{ at: number; text: string }> = [];
  let at = 0;
  for (const part of sentence.split(/(?<=[.!?])\s+/u)) {
    clauses.push({ at, text: part });
    at += part.length;
    // Whatever whitespace the split consumed: found by walking, not guessed.
    while (at < sentence.length && /\s/u.test(sentence[at] as string)) at += 1;
  }
  return clauses.length > 0 ? clauses : [{ at: 0, text: sentence }];
}

/**
 * Does the clause this date sits in carry a word that makes it a commitment?
 *
 * The date's whole phrase is what is placed, not its first character: `Sep. 22`
 * straddles a clause boundary this function itself drew, and the keyword in
 * "Sep. 22 is the deadline" is on the far side of it. Any clause the phrase
 * touches counts.
 */
function keywordBoostAt(
  clauses: Array<{ at: number; text: string }>,
  at: number,
  length: number,
): number {
  for (const clause of clauses) {
    const end = clause.at + clause.text.length;
    if (clause.at > at + length) break;
    if (end < at) continue;
    if (KEYWORDS.test(clause.text)) return KEYWORD_BOOST;
  }
  return 0;
}

function pushCandidate(into: Candidate[], candidate: Candidate | null): void {
  if (candidate !== null) into.push(candidate);
}

function scanSentence(
  sentence: string,
  refDay: number,
  refYear: number,
  refWeekday: number,
  maxDay: number,
): Candidate[] {
  const found: Candidate[] = [];

  for (const m of sentence.matchAll(ISO_RE)) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!realDay(year, month, day)) continue;
    found.push({
      dayNo: dayNumber(year, month, day),
      phrase: m[0],
      base: BASE_CONFIDENCE.iso,
      at: m.index ?? 0,
    });
  }

  for (const m of sentence.matchAll(DAY_MONTH_RE)) {
    pushCandidate(
      found,
      monthNameCandidate(Number(m[1]), m[2] as string, m[3], m[0], refDay, refYear, m.index ?? 0),
    );
  }
  for (const m of sentence.matchAll(MONTH_DAY_RE)) {
    pushCandidate(
      found,
      monthNameCandidate(Number(m[2]), m[1] as string, m[3], m[0], refDay, refYear, m.index ?? 0),
    );
  }

  for (const m of sentence.matchAll(NUMERIC_RE)) {
    pushCandidate(
      found,
      numericCandidate(Number(m[1]), Number(m[2]), m[3], m[0], refDay, refYear, maxDay, m.index ?? 0),
    );
  }

  for (const m of sentence.matchAll(WEEKDAY_TIME_RE)) {
    // A weekday with no time at all is not a date (see the module note): the
    // hour group is what makes the phrase a commitment.
    const hour = m[2] === undefined ? NaN : Number(m[2]);
    // `:mm`, the French `h`, or am/pm. A weekday beside a bare number is not a
    // time — "Thursday 15" is somebody writing the fifteenth, or nothing.
    const hasTime = Number.isFinite(hour) && hour <= 24 &&
      (m[3] !== undefined || m[4] !== undefined || m[6] !== undefined);
    if (!hasTime) continue;
    const weekday = WEEKDAYS[(m[1] as string).toLowerCase()];
    if (weekday === undefined) continue;
    // 0 when the message itself was written on that weekday: "Thursday at 3pm"
    // sent on a Thursday morning is today, and a day already past is caught by
    // the window check rather than guessed at.
    const ahead = (weekday - refWeekday + 7) % 7;
    found.push({
      dayNo: refDay + ahead,
      phrase: m[0].trim(),
      base: BASE_CONFIDENCE.weekdayTime,
      at: m.index ?? 0,
    });
  }

  return found;
}

function monthNameCandidate(
  day: number,
  monthWord: string,
  yearWord: string | undefined,
  phrase: string,
  refDay: number,
  refYear: number,
  at: number,
): Candidate | null {
  const month = MONTHS[monthWord.toLowerCase().replace(/\.$/, '')];
  if (month === undefined) return null;
  const year = yearWord ? Number(yearWord) : resolveYear(month, day, refDay, refYear);
  if (year === null || year === undefined || !realDay(year, month, day)) return null;
  return {
    dayNo: dayNumber(year, month, day),
    phrase: phrase.trim(),
    base: BASE_CONFIDENCE.monthName,
    at,
  };
}

/**
 * `22/09` and `9/22`, the shape that cannot be read without a guess.
 *
 * A number above twelve can only be a day, which settles it. When neither
 * number settles anything both readings are tried and the one that lands inside
 * the window wins — `10/2` in a September mail is 2 October, because 10 February
 * is five months gone and the sender is not writing about it. When *both* land
 * in the window the day-first reading is taken (the owner's mail is mostly
 * French, and most of the world writes the day first). Either way the guess
 * scores `numericAmbiguous`, below the default threshold, so it never speaks
 * without a "deadline" or an "échéance" beside it.
 */
function numericCandidate(
  first: number,
  second: number,
  yearWord: string | undefined,
  phrase: string,
  refDay: number,
  refYear: number,
  maxDay: number,
  at: number,
): Candidate | null {
  // Idioms, not dates. `24/7` is a promise about opening hours and `5/7` is a
  // score; both read as a plausible July day and both would raise a finding in
  // the fortnight before it. A zero-padded month (`05/07`) is somebody writing
  // a date, and is read as one — the deny-list is only the unpadded form.
  if (yearWord === undefined && /^\s*\d{1,2}\s*\/\s*7\s*$/u.test(phrase)) return null;
  const year = yearWord
    ? yearWord.length === 2
      ? 2000 + Number(yearWord)
      : Number(yearWord)
    : null;
  const readings: Array<{ day: number; month: number; ambiguous: boolean }> = [];
  if (first > 12 && second <= 12) readings.push({ day: first, month: second, ambiguous: false });
  else if (second > 12 && first <= 12) readings.push({ day: second, month: first, ambiguous: false });
  else {
    readings.push({ day: first, month: second, ambiguous: true });
    readings.push({ day: second, month: first, ambiguous: true });
  }

  let fallback: Candidate | null = null;
  for (const reading of readings) {
    const resolved = year ?? resolveYear(reading.month, reading.day, refDay, refYear);
    if (resolved === null || !realDay(resolved, reading.month, reading.day)) continue;
    const candidate: Candidate = {
      dayNo: dayNumber(resolved, reading.month, reading.day),
      phrase: phrase.trim(),
      base: reading.ambiguous ? BASE_CONFIDENCE.numericAmbiguous : BASE_CONFIDENCE.numeric,
      at,
    };
    if (candidate.dayNo >= refDay && candidate.dayNo <= maxDay) return candidate;
    fallback ??= candidate;
  }
  // Nothing in the window: hand back the first reading anyway and let the
  // window check in `findDates` be the one place a date is dropped for being
  // out of range.
  return fallback;
}

/**
 * Every date this text states inside the window, best first.
 *
 * One hit per day: two spellings of the same Tuesday are one fact, and the
 * phrase kept is the one that was surest. The list is sorted by confidence and
 * then by day so a caller storing them has a stable order.
 */
export function findDates(text: string, opts: FindDatesOptions): DateHit[] {
  const timezone = opts.timezone ?? 'UTC';
  const windowDays = opts.windowDays ?? DATE_HORIZON_DAYS;
  if (typeof text !== 'string' || text.trim() === '') return [];
  if (Number.isNaN(opts.at.getTime())) return [];

  const refIso = dayString(opts.at, timezone);
  const refDay = dayNumberOf(refIso);
  const refYear = Number(refIso.slice(0, 4));
  // ISO weekday of the reference day: 1970-01-01 was a Thursday (4).
  const refWeekday = ((((refDay + 3) % 7) + 7) % 7) + 1;

  const best = new Map<string, DateHit>();
  // Which reading of an ambiguous `10/2` wins is a plausibility question, and
  // the answer is the fortnight — the sender is writing about something close,
  // not about February. The horizon above is about what is *kept*.
  const plausibleDay = refDay + Math.min(windowDays, DATE_WINDOW_DAYS);
  for (const sentence of sentencesOf(withoutQuotedLines(text))) {
    const clauses = clausesOf(sentence);
    for (const candidate of scanSentence(sentence, refDay, refYear, refWeekday, plausibleDay)) {
      if (candidate.dayNo < refDay || candidate.dayNo > refDay + windowDays) continue;
      const date = isoOf(candidate.dayNo);
      const boost = keywordBoostAt(clauses, candidate.at, candidate.phrase.length);
      const confidence = Math.min(MAX_CONFIDENCE, Math.round((candidate.base + boost) * 100) / 100);
      const kept = best.get(date);
      if (!kept || confidence > kept.confidence) {
        best.set(date, { date, phrase: candidate.phrase, confidence });
      }
    }
  }

  return [...best.values()].sort(
    (a, b) => b.confidence - a.confidence || a.date.localeCompare(b.date),
  );
}

/** Is this hit worth a finding at the owner's threshold? */
export function isConfident(hit: DateHit, threshold: number): boolean {
  return hit.confidence >= threshold;
}

/** Clamp a confidence setting into the range the parser can mean anything in. */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DATE_CONFIDENCE;
  return Math.min(MAX_DATE_CONFIDENCE, Math.max(MIN_DATE_CONFIDENCE, Math.round(value * 100) / 100));
}
