/**
 * What a notification is about, so the same thing said by two agents is one
 * row (docs/notifications.md, "The same thing from two agents").
 *
 * A topic is the words that name things: the title (and the text, when the
 * title alone names fewer than three), lowercased, with the agent's own name,
 * dates, weekdays and the everyday words of a reminder taken out, and numbers
 * written plainly (40.00 is 40). Two topics are the same when they share at
 * least three words and those are at least two thirds of the shorter one.
 * "Pay", "paid" and "payment" are one word.
 */

/** A new message folds into an open row with the same topic from the last this long. */
export const TOPIC_WINDOW_MS = 48 * 3_600_000;

/** At most this many words make a topic. */
const TOPIC_WORDS = 12;

/** Shared words needed, and the share of the shorter topic they must be. */
const MIN_SHARED = 3;
const MIN_SHARE = 2 / 3;

const MONTHS = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul', 'july',
  'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november', 'dec', 'december',
]);

// Words any reminder or report uses whatever it is about: they say nothing about which thing.
const COMMON = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'on', 'in', 'at', 'to', 'for', 'by', 'from', 'with', 'about', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'you', 'your', 'yours', 'i', 'we', 'our', 'me', 'my', 'he', 'she', 'they', 'them', 'their',
  'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no', 'yes', 'so', 'if', 'then', 'than', 'just', 'also', 'still', 'now', 'again', 'up', 'out',
  'least', 'most', 'more', 'less', 'only', 'all', 'any', 'some', 'one', 'new',
  'today', 'tonight', 'tomorrow', 'yesterday', 'week', 'weekend', 'month', 'day', 'days', 'morning', 'evening',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'usd', 'eur', 'gbp', 'cad', 'chf', 'jpy', 'aud', 'dollars', 'euros',
  'due', 'minimum', 'min', 'amount', 'balance', 'card', 'ending', 'ends',
  'reminder', 'remind', 'reminders', 'note', 'heads', 'please', 'need', 'needs', 'make', 'sure', 'check',
  'update', 'found', 'next', 'last', 'before', 'after', 'until', 'soon', 'ago',
]);

/** Words that are one word here. */
const SAME_WORD: Record<string, string> = { paid: 'pay', payment: 'pay', payments: 'pay', paying: 'pay' };

/** The words of `raw`, lowercased, dates out, numbers plain. */
function words(raw: string): string[] {
  const tokens = raw
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}(t[\d:.]+z?)?\b/g, ' ') // ISO dates
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // 9/27, 27/09/2026
    .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, ' ') // 27.09.2026
    .replace(/(\d),(\d{3})/g, '$1$2') // 1,200 is 1200
    .split(/[^\p{L}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    let t = tokens[i] as string;
    if (MONTHS.has(t)) {
      // "Sept 27", "27 Sept": the day goes with the month.
      if (/^\d{1,2}(st|nd|rd|th)?$/.test(tokens[i + 1] ?? '')) i += 1;
      if (out.length > 0 && /^\d{1,2}(st|nd|rd|th)?$/.test(out[out.length - 1] ?? '')) out.pop();
      continue;
    }
    if (/^\d{1,2}(st|nd|rd|th)$/.test(t)) continue; // 27th
    if (/^\d+(\.\d+)?$/.test(t)) t = String(Number(t)); // 40.00 is 40
    else if (t.includes('.')) {
      out.push(...t.split('.').filter(Boolean));
      continue;
    }
    out.push(t);
  }
  return out;
}

/** The agent's own name is not what the message is about. */
function agentWords(agentId: string | null | undefined): Set<string> {
  return new Set((agentId ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
}

function distinctive(raw: string, skip: Set<string>): string[] {
  const seen = new Set<string>();
  for (const w of words(raw)) {
    if (w.length < 2 && !/^\d$/.test(w)) continue;
    const word = SAME_WORD[w] ?? w;
    if (COMMON.has(word) || skip.has(word) || seen.has(word)) continue;
    seen.add(word);
  }
  return [...seen];
}

/**
 * The topic of a message: its distinctive words, space-separated, at most
 * twelve, in the order they first appear. Empty when it names nothing.
 */
export function notificationTopic(message: { title: string; text?: string | null; agentId?: string | null }): string {
  const skip = agentWords(message.agentId);
  let picked = distinctive(message.title, skip);
  if (picked.length < MIN_SHARED && message.text) {
    const more = distinctive(message.text, skip).filter((w) => !picked.includes(w));
    picked = [...picked, ...more];
  }
  return picked.slice(0, TOPIC_WORDS).join(' ');
}

/** Do two topics name the same thing? At least three shared words, at least two thirds of the shorter. */
export function sameTopic(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = new Set(a.split(' '));
  const right = new Set(b.split(' '));
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared >= MIN_SHARED && shared >= MIN_SHARE * Math.min(left.size, right.size);
}
