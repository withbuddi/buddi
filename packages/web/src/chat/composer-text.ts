/**
 * What the composer reads off the text and the caret, and the edits its keys
 * make (docs/dashboard.md, The composer). Pure: every function takes the value
 * and the caret and answers, so each behaviour is tested without a browser.
 *
 * What is sent is always the plain Markdown in the box. Nothing here adds
 * markup the owner did not type, except the fence around pasted code, which
 * comes with an Undo.
 */

/** A paste longer than this becomes a file at once ("Put it in the message"). */
export const LONG_PASTE = 4000;

/** The language a fence names, as the paint's tag says it. */
export const LANGS: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', py: 'Python', sh: 'Shell', bash: 'Shell',
  json: 'JSON', sql: 'SQL', md: 'Markdown', html: 'HTML', css: 'CSS', go: 'Go', rs: 'Rust', yaml: 'YAML', yml: 'YAML',
};

export const langName = (tag: string): string => LANGS[tag.toLowerCase()] ?? tag;

/** An edit: the new value and where the caret goes. */
export interface Edit {
  value: string;
  caret: number;
}

/** The line the caret is on: where it starts and ends, and its text. */
export function lineAt(value: string, caret: number): { start: number; end: number; text: string } {
  const start = value.lastIndexOf('\n', caret - 1) + 1;
  const found = value.indexOf('\n', caret);
  const end = found < 0 ? value.length : found;
  return { start, end, text: value.slice(start, end) };
}

/** Whether the caret's line is inside a fenced block (an odd number of fences above it). */
export function inFence(value: string, caret: number): boolean {
  const above = value.slice(0, lineAt(value, caret).start);
  return (above.match(/^```/gm) ?? []).length % 2 === 1;
}

/** The `@word` being typed at the caret, if any: where its `@` is and what follows it. */
export function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|[\s(])@([a-z0-9-]*)$/i.exec(before);
  if (!match) return null;
  if (inFence(value, caret)) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
}

/**
 * The `/word` being typed, only at the very start of the message and before
 * any space: a slash later on is a path or a fraction, not a command.
 */
export function slashAt(value: string, caret: number): { query: string } | null {
  const match = /^\/([a-z0-9-]*)$/i.exec(value.slice(0, caret));
  return match ? { query: match[1]! } : null;
}

/** `/use @who` being typed: the mention popup offers agents to switch to. */
export function useAt(value: string, caret: number): boolean {
  return /^\/use @?[a-z0-9-]*$/i.test(value.slice(0, caret));
}

/** The whole message as a command, when it is one: `/quiet 1d` → quiet, "1d". */
export function parseCommand(value: string): { name: string; arg: string } | null {
  const match = /^\/([a-z][a-z0-9-]*)(?:[ \t]+([\s\S]*))?$/i.exec(value.trim());
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), arg: (match[2] ?? '').trim() };
}

/** Put `@handle ` in place of the `@word` being typed. */
export function completeMention(value: string, caret: number, start: number, handle: string): Edit {
  const rest = value.slice(caret);
  const space = rest.startsWith(' ') ? '' : ' ';
  const next = `${value.slice(0, start)}@${handle}${space}${rest}`;
  return { value: next, caret: start + handle.length + 2 };
}

const LIST = /^(\s*)([-*]|\d+\.)( )(.*)$/;

/** The list item on the caret's line, if the line is one. */
export function listItem(value: string, caret: number): { indent: string; mark: string; body: string } | null {
  if (inFence(value, caret)) return null;
  const match = LIST.exec(lineAt(value, caret).text);
  return match ? { indent: match[1]!, mark: match[2]!, body: match[4]! } : null;
}

/**
 * Enter on a list item: the next item, numbered on; on an empty item, the
 * list ends (the marker goes, the line stays). Null when not on an item.
 */
export function continueList(value: string, caret: number): Edit | null {
  const item = listItem(value, caret);
  if (!item) return null;
  const line = lineAt(value, caret);
  if (item.body.trim() === '') {
    const next = value.slice(0, line.start) + value.slice(line.end);
    return { value: next, caret: line.start };
  }
  const mark = /\d/.test(item.mark) ? `${parseInt(item.mark, 10) + 1}.` : item.mark;
  const insert = `\n${item.indent}${mark} `;
  return { value: value.slice(0, caret) + insert + value.slice(caret), caret: caret + insert.length };
}

/** Tab / Shift+Tab on a list item: two spaces in or out. Null when not on an item. */
export function indentItem(value: string, caret: number, out: boolean): Edit | null {
  if (!listItem(value, caret)) return null;
  const line = lineAt(value, caret);
  if (!out) return { value: value.slice(0, line.start) + '  ' + value.slice(line.start), caret: caret + 2 };
  const stripped = line.text.replace(/^ {1,2}/, '');
  const removed = line.text.length - stripped.length;
  return { value: value.slice(0, line.start) + stripped + value.slice(line.end), caret: Math.max(line.start, caret - removed) };
}

/** Whether pasted text reads as code: three lines or more, most of them shaped like code, and no fence of its own. */
export function looksLikeCode(text: string): boolean {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length < 3 || /^```/m.test(text)) return false;
  const hits = lines.filter((l) => /[;{}()=<>]\s*$|^\s{2,}\S|^\t+\S|^\s*(const|let|var|function|def|import|from|export|return|if|for|while|class|SELECT|INSERT|UPDATE|<\w)/.test(l)).length;
  return hits / lines.length > 0.5;
}

/** A best guess at the language, for the fence's tag. */
export function guessLang(text: string): string {
  if (/\bdef \w+\(|^\s*import \w+$|^\s*from \w+ import /m.test(text)) return 'py';
  if (/^\s*(SELECT|INSERT|UPDATE|WITH)\b/im.test(text)) return 'sql';
  if (/^\s*[{[]/.test(text) && /"\w+"\s*:/.test(text) && !/;\s*$/m.test(text)) return 'json';
  if (/:\s*\w+[\]>]?\s*[=;),]|\binterface \w+|\bas const\b|\btype \w+ =/.test(text)) return 'ts';
  return 'js';
}

/** Pasted code, fenced at the caret on lines of its own. */
export function fencePaste(value: string, caret: number, text: string, lang: string): Edit {
  const lead = caret > 0 && value[caret - 1] !== '\n' ? '\n' : '';
  const block = `${lead}\`\`\`${lang}\n${text.replace(/\n$/, '')}\n\`\`\`\n`;
  return { value: value.slice(0, caret) + block + value.slice(caret), caret: caret + block.length };
}

/** The handles a message names, in order, once each (fenced and inline code left out). */
export function mentionedHandles(value: string): string[] {
  const prose = value.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const out: string[] = [];
  for (const match of prose.matchAll(/(^|[\s(])@([a-z][a-z0-9-]*)/gi)) {
    const handle = match[2]!.toLowerCase();
    if (!out.includes(handle)) out.push(handle);
  }
  return out;
}

/** `@handle rest` at the very start: who is borrowed and what they are asked. */
export function leadingMention(value: string): { handle: string; rest: string } | null {
  const match = /^@([a-z][a-z0-9-]*)\s*[:,]?[ \t]*([\s\S]*)$/i.exec(value.trim());
  return match ? { handle: match[1]!.toLowerCase(), rest: match[2]!.trim() } : null;
}
