/**
 * The owner's "Answer me in", as a language tag a plugin can use
 * (`ctx.buddi.owner.language()`, docs/plugin-host-api.md §4.1).
 *
 * The profile keeps what the owner typed: "French", "français", "fr-CA".
 * A tag is kept as a tag (the language lowercased, a region uppercased); a
 * common language name, in English or in its own words, becomes its ISO 639-1
 * code. Anything else ("whatever I write in", a typo) is no answer.
 */

const NAMES: Record<string, string> = {
  english: 'en', anglais: 'en', inglés: 'en', ingles: 'en', englisch: 'en',
  french: 'fr', français: 'fr', francais: 'fr', francés: 'fr', frances: 'fr', französisch: 'fr',
  spanish: 'es', español: 'es', espanol: 'es', castellano: 'es', espagnol: 'es',
  german: 'de', deutsch: 'de', allemand: 'de',
  italian: 'it', italiano: 'it', italien: 'it',
  portuguese: 'pt', português: 'pt', portugues: 'pt', portugais: 'pt',
  dutch: 'nl', nederlands: 'nl', néerlandais: 'nl',
  japanese: 'ja', 日本語: 'ja',
  chinese: 'zh', mandarin: 'zh', 中文: 'zh', 普通话: 'zh',
  korean: 'ko', 한국어: 'ko',
  arabic: 'ar', العربية: 'ar',
  russian: 'ru', русский: 'ru',
  hindi: 'hi', हिन्दी: 'hi',
  turkish: 'tr', türkçe: 'tr', turkce: 'tr',
  polish: 'pl', polski: 'pl',
  swedish: 'sv', svenska: 'sv',
  ukrainian: 'uk', українська: 'uk',
  greek: 'el', ελληνικά: 'el',
  hebrew: 'he', עברית: 'he',
  indonesian: 'id', 'bahasa indonesia': 'id',
  vietnamese: 'vi', 'tiếng việt': 'vi',
  thai: 'th', ไทย: 'th',
  persian: 'fa', farsi: 'fa', فارسی: 'fa',
  romanian: 'ro', română: 'ro', romana: 'ro',
  czech: 'cs', čeština: 'cs', cestina: 'cs',
  danish: 'da', dansk: 'da',
  norwegian: 'no', norsk: 'no',
  finnish: 'fi', suomi: 'fi',
  hungarian: 'hu', magyar: 'hu',
  catalan: 'ca', català: 'ca',
  swahili: 'sw', kiswahili: 'sw',
};

// Two or three letters would also read "no", "it" and "de" as tags; they are
// tags too, so that is right. Words longer than three letters are names.
const TAG = /^([a-z]{2,3})(?:[-_]([a-z]{4}))?(?:[-_]([a-z]{2}|\d{3}))?$/i;

/** "French" → "fr", "pt_br" → "pt-BR", "Klingon" → undefined. */
export function languageTag(value: string | null | undefined): string | undefined {
  const raw = value?.trim().replace(/\s+/g, ' ');
  if (!raw) return undefined;
  const named = NAMES[raw.toLowerCase()];
  if (named) return named;
  const tag = TAG.exec(raw);
  if (!tag) return undefined;
  const [, lang, script, region] = tag as unknown as [string, string, string | undefined, string | undefined];
  return [
    lang.toLowerCase(),
    ...(script ? [script.charAt(0).toUpperCase() + script.slice(1).toLowerCase()] : []),
    ...(region ? [region.toUpperCase()] : []),
  ].join('-');
}
