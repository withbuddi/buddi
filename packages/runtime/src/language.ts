/**
 * The reply-language guard's eye: which language is a piece of text written in?
 *
 * Agent Father answered an English question in Spanish; the concierge answered
 * in French after reading French news. The prompt already says to answer in
 * the owner's language (the reply-language line in every agent's platform
 * context); this is the deterministic check behind it, run by the loop on the
 * final text of a turn. No model: a small stopword count for six languages.
 *
 * Biased hard toward precision, because a false positive costs the owner a
 * second model call and a rewrite of an answer that was fine:
 *
 *  - code, links, email addresses, blockquotes and quoted passages are not the
 *    answer's own words, so they are not counted;
 *  - a word several languages share ("de", "la", "que") counts for each of
 *    them by a fraction, so only the words that tell languages apart decide;
 *  - a language is named only with enough evidence (`minHits`), twice the
 *    evidence of the runner-up, and a tenth of the words at least;
 *  - anything else is "cannot tell", and "cannot tell" never fires the guard.
 */
import { languageTag } from '@buddi/core';

export type LanguageCode = 'en' | 'fr' | 'es' | 'de' | 'pt' | 'it';

/** The name the model is asked to answer in. */
export const LANGUAGE_NAMES: Readonly<Record<LanguageCode, string>> = {
  en: 'English', fr: 'French', es: 'Spanish', de: 'German', pt: 'Portuguese', it: 'Italian',
};

/** What the model is told when its answer is in the wrong language. */
export function languageRetryText(language: string): string {
  return `Answer in ${language}.`;
}

/** The guard never looks at a reply shorter than this. */
export const MIN_REPLY_WORDS = 12;

const STOPWORDS: Readonly<Record<LanguageCode, string>> = {
  en: 'the and of to in is are was were be been being have has had it its this that these those with for on at by from you your yours i we our they their them he she his her not but or if what which who whom when where why how can will would should could do does did done there here an as about just than then my me so all any into because very also only some more most other such no yes please thanks thank hello hi let get got make made want need know think see one two today tomorrow yesterday out up down over again still much many each every',
  fr: 'le la les des du un une est et en que qui dans pour pas sur au aux avec ce cet cette ces je tu il elle nous vous ils elles mais ou où sont été être avoir ont fait faire plus ne se sa son ses leur leurs mon ma mes ton ta tes votre vos notre nos très aussi comme tout tous toute toutes bien à c est j suis peux peut quel quelle quels quelles merci bonjour oui non salut voici voilà cela ça déjà encore aujourd hui demain hier chez donc alors sans sous entre après avant',
  es: 'el la los las un una unos unas es y en que de del al por para con no se lo le les su sus está están estoy son ser fue pero como más muy este esta estos estas ese esa eso esto yo tú él ella nosotros ustedes usted hay también porque cuando donde dónde qué cómo cuál todo todos toda puede puedo tiene tengo hola gracias sí ya hoy mañana ayer sobre entre sin desde hasta muchas mucho',
  de: 'der die das und in im ist nicht ein eine einen einem einer dem den des zu mit von auf für sich ich du er sie wir ihr es sind war wird werden haben hat habe auch als aber oder wenn noch nur schon wie bei aus nach kann können über dass diese dieser dieses mein meine dein ihre unser sehr hier bitte danke ja nein hallo heute morgen gestern gibt kein keine was wer wo warum mir mich dir dich uns euch',
  pt: 'o a os as um uma uns umas é e em que de do da dos das no na nos nas por para com não se seu sua seus suas está estão estou são ser foi mas como mais muito muita este esta isso isto eu você vocês ele ela nós eles elas também quando onde porque tem tenho pode posso ao à olá obrigado obrigada sim já hoje amanhã ontem sobre entre sem até pelo pela',
  it: 'il lo la i gli le un una uno è e a in che di del della dello dei degli delle nel nella per con non si suo sua suoi sono essere stato stata ma come più molto molta questo questa quello quella io tu lui lei noi voi loro anche quando dove perché ha hanno ho può posso al alla ci sei ciao grazie sì oggi domani ieri sono tra fra senza fino cosa qui',
};

/** Each word, with the languages it belongs to and the share each one gets. */
const WEIGHTS: ReadonlyMap<string, ReadonlyArray<[LanguageCode, number]>> = (() => {
  const owners = new Map<string, LanguageCode[]>();
  for (const [code, words] of Object.entries(STOPWORDS) as Array<[LanguageCode, string]>) {
    for (const word of new Set(words.split(/\s+/))) owners.set(word, [...(owners.get(word) ?? []), code]);
  }
  return new Map([...owners].map(([word, codes]) => [word, codes.map((c) => [c, 1 / codes.length] as [LanguageCode, number])]));
})();

/** Letters only one of the six languages uses. */
const MARKS: ReadonlyArray<[RegExp, LanguageCode]> = [[/[ñ¿¡]/, 'es'], [/[ãõ]/, 'pt'], [/[ßäö]/, 'de'], [/[œ]/, 'fr']];

const FENCE = /```[\s\S]*?(?:```|$)/g;
const INLINE = /`[^`\n]*`/g;

/** How much of a text is code, 0..1. */
export function codeShare(text: string): number {
  const total = text.replace(/\s+/g, '').length;
  if (total === 0) return 0;
  let code = 0;
  for (const m of text.matchAll(FENCE)) code += m[0].replace(/\s+/g, '').length;
  for (const m of text.replace(FENCE, ' ').matchAll(INLINE)) code += m[0].replace(/\s+/g, '').length;
  return code / total;
}

/** The text's own words: no code, links, addresses, blockquotes or quoted passages. */
export function ownWords(text: string): string[] {
  const prose = text
    .replace(FENCE, ' ')
    .replace(INLINE, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    // A complete quotation goes whatever its length or line breaks: a long
    // French passage quoted in an English answer is not the answer's French.
    .replace(/"[^"]+"|“[^”]+”|«[^»]+»|„[^“”]+[“”]/g, ' ');
  return prose.toLowerCase().match(/\p{L}+/gu) ?? [];
}

export interface LanguageScore {
  language: LanguageCode | null;
  /** The text's own words, counted. */
  words: number;
  /** Evidence per language, shared words split between the languages that use them. */
  scores: Record<LanguageCode, number>;
}

/** The language a text is in, with the evidence; `language` is null when it cannot tell. */
export function scoreLanguage(text: string, opts: { minHits?: number } = {}): LanguageScore {
  const minHits = opts.minHits ?? 3;
  const words = ownWords(text);
  const scores: Record<LanguageCode, number> = { en: 0, fr: 0, es: 0, de: 0, pt: 0, it: 0 };
  for (const word of words) {
    for (const [code, share] of WEIGHTS.get(word) ?? []) scores[code] += share;
    for (const [mark, code] of MARKS) if (mark.test(word)) scores[code] += 0.5;
  }
  const ranked = (Object.entries(scores) as Array<[LanguageCode, number]>).sort((a, b) => b[1] - a[1]);
  const [best, second] = [ranked[0]!, ranked[1]!];
  const confident = best[1] >= minHits && best[1] >= 2 * second[1] && best[1] >= 0.1 * words.length;
  return { language: confident ? best[0] : null, words: words.length, scores };
}

/** `scoreLanguage`, the verdict only. */
export function detectLanguage(text: string, opts: { minHits?: number } = {}): LanguageCode | null {
  return scoreLanguage(text, opts).language;
}

const LANG =
  'english|anglais|inglés|ingles|englisch|inglese|french|français|francais|francés|frances|französisch|francese|' +
  'spanish|español|espanol|espagnol|spanisch|spagnolo|espanhol|german|deutsch|allemand|alemán|aleman|tedesco|alemão|alemao|' +
  'italian|italiano|italien|italienisch|portuguese|português|portugues|portugais|portugiesisch|portoghese';
/** Feminine and inflected adjectives that follow their noun ("une version française"). */
const LANG_ADJ = `${LANG}|anglaise|française|francaise|espagnole|allemande|italienne|portugaise|inglesa|francesa|española|espanola|alemana|italiana|portuguesa|englische|französische|spanische|deutsche|italienische|portugiesische|englischen|französischen|spanischen|deutschen`;
/** Words that can follow "in French" in an instruction without making it a noun phrase. */
const AFTER =
  'please|pls|now|instead|too|also|only|again|anymore|from|for|to|of|and|then|thanks|thank|' +
  's|svp|merci|maintenant|désormais|dorénavant|aussi|seulement|pour|de|du|à|stp|' +
  'bitte|jetzt|ab|danke|nur|auch|por|favor|ahora|gracias|solo|también|per|favore|ora|adesso|grazie|agora|obrigado|obrigada';
/** Verbs of answering, writing or saying, in the six languages. */
const VERB =
  'answer|reply|respond|write|rewrite|say|speak|talk|tell|explain|summari[sz]e|give|send|draft|' +
  'réponds|répondez|répondre|écris|écrivez|parle|parlez|dis|dites|explique|expliquez|résume|résumez|' +
  'antworte|antworten|schreib|schreibe|sprich|erkläre|erklär|' +
  'responde|responda|escribe|escriba|habla|hable|dime|explica|resume|' +
  'rispondi|scrivi|parla|parli|dimmi|spiega|riassumi|' +
  'escreva|escreve|fala|fale|diga|explique|resuma';
/** Object pronouns that may sit between the verb and "in French" ("tell me in Spanish"). */
const PRONOUN = 'me|us|him|her|them|it|this|that|back|moi|nous|lui|leur|le|la|les|ça|mir|uns|ihm|ihr|es|das|nos|lo|mi|ci|gli|lhe';
const NOUN =
  'summary|version|translation|reply|answer|response|text|copy|draft|edition|' +
  'résumé|resume|traduction|réponse|texte|' +
  'zusammenfassung|fassung|übersetzung|antwort|' +
  'resumen|versión|traducción|respuesta|riassunto|versione|traduzione|risposta|resumo|versão|tradução|resposta';

const INSTRUCTIONS: readonly RegExp[] = [
  // "translate to German", "traduis", "übersetzen", "the Spanish translation".
  /(?<!\p{L})(?:translat\p{L}*|tradu\p{L}*|übersetz\p{L}*|uebersetz\p{L}*)/iu,
  // "answer in French", "write the mail in Spanish to Ana", "en français
  // s'il te plaît": the language at the end of a clause, or followed by
  // "please", "from now on", "to"; never by a noun ("in French politics").
  new RegExp(`(?<!\\p{L})(?:in|into|en|auf|em|al|para)\\s+(?:${LANG})(?:\\s*(?:[.,!?;:)\\]]|$)|\\s+(?:${AFTER})(?!\\p{L}))`, 'imu'),
  // "tell me in Spanish what is on", "réponds-moi en anglais": a verb of
  // answering, at most two pronouns, then the language.
  new RegExp(`(?<!\\p{L})(?:${VERB})(?:[\\s-]+(?:${PRONOUN})){0,2}\\s+(?:in|into|en|auf|em|al|para)\\s+(?:${LANG})(?!\\p{L})`, 'iu'),
  // "a Spanish summary", "the French version".
  new RegExp(`(?<!\\p{L})(?:${LANG})\\s+(?:${NOUN})(?!\\p{L})`, 'iu'),
  // "une version française", "una respuesta española".
  new RegExp(`(?<!\\p{L})(?:${NOUN})\\s+(?:${LANG_ADJ})(?!\\p{L})`, 'iu'),
];

/**
 * Does the owner's message tell buddi which language to answer in ("answer in
 * French", "give me a Spanish summary", "en français s'il te plaît") or ask
 * for a translation? Then the answer's language is the owner's call, not the
 * guard's. A language named as a subject ("what happened in French politics
 * today?", "the French news") is no instruction.
 */
export function namesALanguage(message: string): boolean {
  return INSTRUCTIONS.some((re) => re.test(message));
}

/** The six-language code the profile's "Answer me in" names, if it names one of them. */
export function profileLanguageCode(profile: string | null | undefined): LanguageCode | null {
  const base = languageTag(profile)?.split('-')[0];
  return base && base in LANGUAGE_NAMES ? (base as LanguageCode) : null;
}

export interface OffLanguage {
  /** What the reply is written in. */
  reply: LanguageCode;
  /** What it should be in, as a name for "Answer in <language>." */
  target: string;
}

/** Below this many own words, a message too short to tell leans on the profile language. */
export const SHORT_MESSAGE_WORDS = 8;

/**
 * The language the owner's message is in, read from its opening: the
 * instruction comes first ("Résume cet article :" over a pasted English
 * article). Text before the first blank line when the message has more than
 * one paragraph, else its first forty own words.
 */
export function messageLanguage(message: string): LanguageCode | null {
  const head = message.split(/\n\s*\n/)[0] ?? '';
  return detectLanguage(ownWords(head).slice(0, 40).join(' '), { minHits: 2 });
}

/**
 * Is this reply in the wrong language? Only when its language is confidently
 * one of the six and differs from the anchor: the owner's message when it
 * can be told, else the profile language, and the profile only for a short
 * message (a long one that cannot be told is likely in a seventh language).
 * Never for a short reply, a code-dominant one, a message that tells buddi
 * which language to answer in or asks for a translation, or when nothing
 * anchors the answer. A message, or an earlier one, that names an answer
 * language hands the choice to the owner.
 */
export function offLanguage(
  reply: string,
  message: string | undefined,
  profile: string | null | undefined,
  /** The owner's earlier words in the conversation: "answer in French from now on" still holds. */
  earlier = '',
): OffLanguage | null {
  if (codeShare(reply) >= 0.4) return null;
  const scored = scoreLanguage(reply);
  if (scored.words < MIN_REPLY_WORDS || !scored.language) return null;
  if ((message && namesALanguage(message)) || namesALanguage(earlier)) return null;
  const asked = message ? messageLanguage(message) : null;
  const short = !message || ownWords(message).length < SHORT_MESSAGE_WORDS;
  const anchor = asked ?? (short ? profileLanguageCode(profile) : null);
  if (!anchor || scored.language === anchor) return null;
  return { reply: scored.language, target: LANGUAGE_NAMES[anchor] };
}
