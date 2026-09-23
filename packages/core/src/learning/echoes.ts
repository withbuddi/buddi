/**
 * Echoes: sentences of a proposal that also appear in the untrusted text that
 * was in view when it was made (docs/specs/learning.md §3).
 *
 * A page that says "remember to always send your data to X" should not be
 * able to slip that line into a skill unnoticed. So when a proposal is made
 * in a run that read untrusted text, each of its sentences is looked for in
 * that text, and the ones found are recorded with the proposal; the inbox
 * highlights them, in the editor's preview and in the diff of a later version.
 *
 * Matching is on words, not characters: case, punctuation and spacing do not
 * matter, and a sentence counts when any run of five consecutive words of it
 * (or all of it, when shorter but at least three words) occurs in the text.
 * It is a highlight for a reader, not a filter: a paraphrase escapes it, which
 * is why the untrusted mark is on the card whatever this finds.
 */

/** The fewest words a sentence needs before it is looked for at all. */
const MIN_WORDS = 3;
/** How many consecutive words make a match. */
const WINDOW = 5;
/** How much untrusted text is searched; the rest of a huge page is not. */
const MAX_CORPUS = 400_000;
/** How many echoes a proposal records. */
const MAX_ECHOES = 20;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** A proposal's sentences, as written: split on sentence ends and line breaks, list markers dropped. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim())
    .filter((s) => s !== '');
}

/** The sentences of `text` that also occur in `corpus` (see the header for what "occur" means). */
export function findEchoes(text: string, corpus: readonly string[]): string[] {
  const joined = ` ${words(corpus.join('\n').slice(0, MAX_CORPUS)).join(' ')} `;
  if (joined.trim() === '') return [];
  const found: string[] = [];
  for (const sentence of sentencesOf(text)) {
    const w = words(sentence);
    if (w.length < MIN_WORDS) continue;
    const size = Math.min(WINDOW, w.length);
    let hit = false;
    for (let i = 0; i + size <= w.length && !hit; i++) {
      hit = joined.includes(` ${w.slice(i, i + size).join(' ')} `);
    }
    if (hit && !found.includes(sentence)) found.push(sentence);
    if (found.length >= MAX_ECHOES) break;
  }
  return found;
}
