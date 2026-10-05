/**
 * The grounding guard's eye: does a reply name sources it never read?
 *
 * An owner asked the concierge about a headline in today's news; it answered
 * at length, citing CBS, AP, NPR and a law school, with no tool call at all.
 * Every citation was invented. The prompt already says not to (the grounding
 * lines in every agent's platform context); this is the deterministic check
 * behind it, run by the loop on the final text of a turn that read nothing.
 *
 * Biased hard toward precision, because a false positive costs the owner a
 * second model call and, worse, a "not checked" flag on an honest answer:
 *
 *  - an outlet or a domain counts only where it is *cited* — in parentheses,
 *    after "according to" / "selon" / "d'après" / "per" / "via", before
 *    "reports" / "said" / "writes", or as a markdown link. "The BBC is a
 *    broadcaster" is a mention, not a citation, and so is a bare link ("open
 *    https://github.com"): a bare link only backs up markers or a "Sources:"
 *    line, it never counts as a source on its own;
 *  - one citation is not enough on its own: it takes two distinct sources, or
 *    one (or a bare link) with numbered markers ([1]) or a "Sources:" line;
 *  - an outlet and its own domain ("Reuters", "reuters.com") are one source;
 *  - a source the conversation already holds (the owner named it, a tool
 *    returned it earlier) is not counted;
 *  - code is ignored, and so is an email address.
 *
 * Figures alone are never a signal: "it costs about €20" is how people talk.
 */

/** What the model is told when it cited sources without reading anything. */
export const GROUNDING_RETRY_TEXT =
  'You cited sources without reading anything. Verify with your tools or a colleague, or remove the claims.';

/** The muted line the surfaces draw under a reply the guard could not get checked. */
export const UNCHECKED_LINE = 'Answered from memory, not checked';

/**
 * News outlets and agencies a model reaches for when it invents a citation.
 * Not a directory: the names that showed up in fabricated answers, and their
 * neighbours. Matched case-sensitively, so "AP" is the agency and "ap" is not.
 */
const OUTLETS: readonly string[] = [
  'Associated Press', 'AP', 'Reuters', 'AFP', 'Agence France-Presse', 'Bloomberg',
  'BBC', 'CNN', 'CBS', 'NBC', 'ABC News', 'NPR', 'PBS', 'Fox News', 'MSNBC', 'CNBC',
  'New York Times', 'NYT', 'Washington Post', 'Wall Street Journal', 'WSJ', 'USA Today',
  'Los Angeles Times', 'The Guardian', 'Financial Times', 'The Economist', 'Politico', 'Axios',
  'The Atlantic', 'The Hill', 'Al Jazeera', 'Sky News', 'The Telegraph', 'The Times', 'Forbes',
  'TechCrunch', 'The Verge', 'Le Monde', 'Le Figaro', 'Libération', 'Les Echos', 'France 24',
  'franceinfo', 'Le Parisien', 'RFI', 'Der Spiegel', 'El País', 'Deutsche Welle', 'Euronews',
  'Jeune Afrique', 'Nikkei', 'South China Morning Post',
];

const TLDS = 'com|org|net|gov|edu|int|news|info|co\\.uk|org\\.uk|ac\\.uk|fr|de|es|it|ch|be|ca|au|uk|eu|tv|us|ng|tg|sn|ci|za|ke|jp|in';
/** A host name, with or without a scheme. Not preceded by `@` (an email) or a word character. */
const DOMAIN = new RegExp(`(?<![@\\w.-])(?:https?://)?(?:www\\.)?((?:[a-z0-9-]+\\.)+(?:${TLDS}))(?![\\w-])`, 'gi');
const URL = /https?:\/\/[^\s)>\]]+/gi;
const ATTRIBUTION = /\b(?:[Aa]ccording to|[Ss]elon|[Dd]['’]apr[eè]s|[Aa]s reported by|[Rr]eported by|[Cc]ited by)\s+(?:the\s+|l[ae]\s+|les\s+|l['’])?([A-Z][\p{L}&.'’-]*(?:\s+(?:of\s+|de\s+|du\s+|for\s+)?[A-Z][\p{L}&.'’-]*){0,4})/gu;
/** Right before a citation: "according to", "per", "via", "source:". */
const BEFORE = /(?:according to|selon|d['’]apr[eè]s|as reported by|reported by|cited by|\bper|\bvia|sources?\s*:)\s+(?:the\s+|l[ae]\s+|les\s+)?$/i;
/** Right after one: "reports", "said", "writes". */
const AFTER = /^['’]?s?\s+(?:has\s+|have\s+|had\s+)?(?:reports?|reported|reporting|said|says|wrote|writes|notes?|noted|confirmed|found|revealed|rapporte|indique|affirme|écrit|a rapporté|a indiqué)\b/i;
const MARKER = /\[(\d{1,2})\](?!\()|[¹²³⁴⁵⁶⁷⁸⁹]/g;
const SOURCES_LINE = /^\s*(?:[*_#>-]+\s*)?(?:Sources?|R[ée]f[ée]rences?|References)\s*(?:[*_]+)?\s*:/im;

export interface CitationSignals {
  /** Distinct sources cited, normalised, that the conversation did not already hold. */
  sources: string[];
  /** Bare links outside a citation position: they back up markers, nothing more. */
  links: string[];
  /** Distinct numbered citation markers ([1], ²). */
  markers: number;
  /** A "Sources:" / "References:" line. */
  sourcesLine: boolean;
}

/** Code is not prose: a fenced block or inline code never cites anything. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

const norm = (token: string): string =>
  token.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^www\./, '').replace(/^the\s+/, '').trim();

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compact = (name: string): string => norm(name).replace(/[^a-z0-9]/g, '');
/** Each outlet under the keys its own domain is likely to carry: "reuters", "cbsnews", "theguardian". */
const OUTLET_KEYS: ReadonlyMap<string, string> = new Map(OUTLETS.flatMap((outlet) => {
  const key = compact(outlet);
  const raw = outlet.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return [...new Set([key, `${key}news`, raw, `${raw}news`])].map((k) => [k, norm(outlet)] as [string, string]);
}));
const TLD_SUFFIX = new RegExp(`\\.(?:${TLDS})$`, 'i');
/** The outlet a host belongs to ("www.reuters.com" → "reuters"), or the host itself. */
function sourceOfHost(host: string): string {
  const label = norm(host).replace(TLD_SUFFIX, '').split('.').pop() ?? '';
  return OUTLET_KEYS.get(label) ?? host;
}

/** Is the occurrence at [start, end) in a citation position? */
function cited(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 40), start);
  if (BEFORE.test(before)) return true;
  if (AFTER.test(text.slice(end, end + 40))) return true;
  // Inside a short parenthesis: "(CBS News, Oct 3)", "(reuters.com)".
  const open = text.lastIndexOf('(', start);
  if (open !== -1 && start - open <= 60 && !text.slice(open, start).includes(')')) {
    const close = text.indexOf(')', end);
    if (close !== -1 && close - end <= 60 && !text.slice(end, close).includes('(')) return true;
  }
  // A markdown link's label: "[CBS News](https://…)".
  const bracket = text.lastIndexOf('[', start);
  if (bracket !== -1 && start - bracket <= 80 && !text.slice(bracket, start).includes(']')) {
    const shut = text.indexOf('](', end);
    if (shut !== -1 && shut - end <= 80 && !text.slice(end, shut).includes('[')) return true;
  }
  return false;
}

/**
 * The citation signals in a reply. `known` is everything the conversation
 * already held before this answer (the owner's words, earlier tool results,
 * earlier replies): a source found there is not counted.
 */
export function citationSignals(reply: string, known = ''): CitationSignals {
  const text = stripCode(reply);
  const found = new Set<string>();
  const bare = new Set<string>();
  const add = (token: string, into: Set<string> = found): void => {
    const n = norm(token);
    if (n.length >= 2) into.add(n);
  };

  for (const outlet of OUTLETS) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(outlet)}(?:\\s+News)?(?![\\p{L}\\p{N}])`, 'gu');
    for (const m of text.matchAll(re)) {
      if (cited(text, m.index!, m.index! + m[0].length)) add(outlet);
    }
  }
  for (const m of text.matchAll(URL)) {
    const host = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(m[0])?.[1];
    if (host) add(sourceOfHost(host), cited(text, m.index!, m.index! + m[0].length) ? found : bare);
  }
  for (const m of text.matchAll(DOMAIN)) {
    if (cited(text, m.index!, m.index! + m[0].length)) add(sourceOfHost(m[1]!));
  }
  for (const m of text.matchAll(ATTRIBUTION)) {
    const name = m[1]!.replace(/[.,;:'’]+$/, '');
    // An outlet already counted under its own name is one source, not two.
    const outlet = OUTLETS.find((o) => name === o || name.startsWith(`${o} `));
    add(outlet ?? name);
  }

  const held = known.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const unheld = (token: string): boolean => !new RegExp(`(?<![\\p{L}\\p{N}])${escape(token)}(?![\\p{L}\\p{N}])`, 'u').test(held);
  const sources = [...found].filter(unheld);
  const links = [...bare].filter((token) => !found.has(token) && unheld(token));

  const markers = new Set<string>();
  for (const m of text.matchAll(MARKER)) markers.add(m[1] ?? m[0]);
  return { sources, links, markers: markers.size, sourcesLine: SOURCES_LINE.test(text) };
}

/**
 * Does this reply cite sources the conversation never read? The loop asks
 * only for the final text of a turn in which nothing was read — no tool call,
 * no delegation, no native search — so "cites" here means "invented".
 */
export function citesUnread(reply: string, known = ''): boolean {
  const s = citationSignals(reply, known);
  if (s.sources.length >= 2) return true;
  if (s.sources.length + s.links.length >= 1 && (s.markers >= 1 || s.sourcesLine)) return true;
  return s.markers >= 2 && s.sourcesLine;
}
