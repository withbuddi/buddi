/**
 * What a tool grant actually reaches, in the tools' own words.
 *
 * Creating an agent is not like writing a file. The privilege boundary in this
 * system is the list in `tools:` — an agent can call exactly what its file
 * names — so approving `platform.create_agent` is approving *access*, and the
 * only question the owner really has to answer is "what will this thing be able
 * to see?". Every preview here is built around that question and nothing else
 * is allowed above it.
 *
 * Two rules decide the shape:
 *
 *  - **the words are the registry's, not ours.** A hard-coded sentence about
 *    "finance tools" would be a sentence nobody maintains, and would say
 *    nothing at all about a plugin this file has never heard of. So the reach
 *    is rendered from the registered tools' own descriptions — the same text
 *    the model reads before it calls one — and a family that arrives tomorrow
 *    is described tomorrow without touching this file.
 *  - **widening is louder than granting.** An update that adds tools shows what
 *    was *added*, separately and first, because "Scout can now read every
 *    balance you have" is a different decision from "Scout still reads what it
 *    read yesterday", and the two must never look alike at a glance.
 *
 * Everything in this module is pure: names and descriptions in, text out.
 */
import type { ToolSpec } from '@buddi/core';

/** A family (`finance`) and the granted tools inside it, in registry order. */
export interface GrantFamily {
  family: string;
  tools: ToolSpec[];
}

/** How many tools of one family the preview names before it counts the rest. */
export const MAX_TOOLS_SHOWN_PER_FAMILY = 6;

/** The part of a tool name before the first dot: `finance.summary` → `finance`. */
export function familyOf(name: string): string {
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/**
 * The first sentence of a tool description, clipped.
 *
 * A tool description is written for a model and runs to a paragraph; the owner
 * is reading an approval on a phone. The first sentence is what the tool leads
 * with, which is the closest thing to a one-line summary its author wrote.
 */
export function firstSentence(text: string, max = 130): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const stop = /[.:?!](\s|$)/.exec(flat);
  const sentence = stop ? flat.slice(0, stop.index + 1) : flat;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

/** Group resolved tool names into families, keeping the registry's own order. */
export function groupGrant(names: readonly string[], specs: readonly ToolSpec[]): GrantFamily[] {
  const wanted = new Set(names);
  const families = new Map<string, ToolSpec[]>();
  for (const spec of specs) {
    if (!wanted.has(spec.name)) continue;
    const family = familyOf(spec.name);
    const bucket = families.get(family);
    if (bucket) bucket.push(spec);
    else families.set(family, [spec]);
  }
  return [...families.entries()].map(([family, tools]) => ({ family, tools }));
}

/** `your finance tools (34), your memory tools (5) and agent.delegate` */
function familyPhrases(families: readonly GrantFamily[]): string[] {
  return families.map(({ family, tools }) =>
    tools.length === 1 ? (tools[0] as ToolSpec).name : `your ${family} tools (${tools.length})`,
  );
}

function listWords(words: readonly string[]): string {
  if (words.length === 0) return 'nothing';
  if (words.length === 1) return words[0] as string;
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] as string}`;
}

/**
 * The one sentence that has to be right: who gets what.
 *
 * `verb` differs between a grant and a widening ("gives" / "adds"), because the
 * same list of tool names means a different thing in each case.
 */
export function grantHeadline(
  handle: string,
  families: readonly GrantFamily[],
  verb: 'gives' | 'adds' = 'gives',
): string {
  const count = families.reduce((sum, f) => sum + f.tools.length, 0);
  if (count === 0) return `This gives @${handle} no tools at all: it can only talk.`;
  const tail = count === 1 ? '' : ` — ${count} tools in all.`;
  return `This ${verb} @${handle} ${listWords(familyPhrases(families))}${tail}`;
}

/**
 * The itemised reach: every granted family, and what its tools say they do.
 *
 * Long families are clipped by *count*, never by meaning: the names that do not
 * fit are counted, and the complete list is in the envelope, which the
 * dashboard prints field by field and nothing summarises away.
 */
export function grantDetail(families: readonly GrantFamily[]): string[] {
  const lines: string[] = [];
  for (const { family, tools } of families) {
    lines.push(`  ${family} — ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}:`);
    for (const tool of tools.slice(0, MAX_TOOLS_SHOWN_PER_FAMILY)) {
      lines.push(`    ${tool.name} — ${firstSentence(tool.description)}`);
    }
    const hidden = tools.length - MAX_TOOLS_SHOWN_PER_FAMILY;
    if (hidden > 0) {
      lines.push(`    …and ${hidden} more ${family} tools, every one listed in the envelope.`);
    }
  }
  return lines;
}

/**
 * What it will *not* reach, named.
 *
 * The families this installation has and this agent was not given. It is the
 * half of the answer a list of granted tools cannot give: an owner reading
 * "memory and reminders" still has to remember what else exists before they
 * know that mail and money are not on the list.
 */
export function withheldLine(
  granted: readonly GrantFamily[],
  specs: readonly ToolSpec[],
): string | undefined {
  const has = new Set(granted.map((f) => f.family));
  // Read-only platform facts are automatic, not withheld agent permissions.
  const rest = [...new Set(specs.map((s) => familyOf(s.name)))].filter((f) => f !== 'system' && !has.has(f));
  if (rest.length === 0) return undefined;
  return `It reaches nothing else — not ${listWords(rest)}.`;
}

/** The whole grant block: headline, itemised reach, and what is withheld. */
export function grantBlock(
  handle: string,
  names: readonly string[],
  specs: readonly ToolSpec[],
): string[] {
  const families = groupGrant(names, specs);
  const withheld = withheldLine(families, specs);
  return [
    grantHeadline(handle, families),
    ...(families.length === 0 ? [] : ['What that reaches:', ...grantDetail(families)]),
    ...(withheld === undefined ? [] : [withheld]),
  ];
}

/** Added, removed and kept, comparing two resolved grants. */
export interface GrantChange {
  added: string[];
  removed: string[];
  kept: string[];
  widened: boolean;
}

export function diffGrant(before: readonly string[], after: readonly string[]): GrantChange {
  const had = new Set(before);
  const has = new Set(after);
  const added = after.filter((name) => !had.has(name));
  const removed = before.filter((name) => !has.has(name));
  return { added, removed, kept: after.filter((name) => had.has(name)), widened: added.length > 0 };
}

/**
 * The grant block for an *update*, where the added tools come first and are
 * labelled as what they are.
 */
export function grantChangeBlock(
  handle: string,
  change: GrantChange,
  specs: readonly ToolSpec[],
): string[] {
  if (!change.widened && change.removed.length === 0) {
    return [`Its tool grant does not change: ${change.kept.length} tools, the same ones as now.`];
  }
  const lines: string[] = [];
  if (change.widened) {
    const addedFamilies = groupGrant(change.added, specs);
    lines.push(
      `THIS WIDENS WHAT @${handle} CAN REACH.`,
      grantHeadline(handle, addedFamilies, 'adds'),
      'What it newly reaches:',
      ...grantDetail(addedFamilies),
    );
  }
  if (change.removed.length > 0) {
    lines.push(`Taken away: ${change.removed.join(', ')}.`);
  }
  lines.push(
    change.kept.length === 0
      ? 'It keeps no tools it already had.'
      : `Unchanged, and it already had these: ${change.kept.join(', ')}.`,
  );
  return lines;
}
