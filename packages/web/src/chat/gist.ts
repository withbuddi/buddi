/**
 * The one line that tells twelve tool rows apart.
 *
 * "Developer · Write" said twelve times is a list of verbs; the thing the owner
 * is scanning for is *which file* and *which command*. So a row carries, after
 * its label, a short monospace gist read out of the call's own arguments: the
 * path a write went to, the command a run ran, the query a search looked for.
 *
 * It is read from the **input**, never the output, for two reasons. The input
 * is there the moment the call starts, so a row says what it is doing rather
 * than only that it is doing something; and the input is what the model asked
 * for, which is the sentence the owner is checking.
 *
 * **By shape, never by name.** This page does not know any plugin's tools (the
 * bundle test holds it to that), so the gist is the argument that is
 * conventionally the subject of a call — a `command`, a `query`, a `path`, a
 * `url`, a `dir` — tried in that order: a search scoped to a directory is
 * about its query, a run in a subdirectory is about its command. Two shapes
 * read as a pair: a command with a `name` is a process the agent named
 * (`dev: pnpm dev`), and an `action` is said with what it was about
 * (`commit · fix the header`). Failing all that, an input with exactly one
 * string argument is about that string. Otherwise there is no gist, and an
 * object is never drawn, because `[object Object]` is not a gist.
 */

/** Longest gist, in characters, before it is cut with an ellipsis. */
export const GIST_MAX = 80;

/** The fields that are the subject of a call, in the order they are tried. */
const SUBJECT_FIELDS = ['query', 'path', 'url', 'dir'] as const;

/** What an `action` was about, when the call says. */
const ABOUT_FIELDS = ['message', 'task'] as const;

export function gistFor(_name: string, input: unknown): string | null {
  const args = record(input);
  if (!args) return null;

  const command = text(args['command']);
  if (command !== null) {
    const label = text(args['name']);
    return clip(label === null ? command : `${label}: ${command}`);
  }
  for (const field of SUBJECT_FIELDS) {
    const value = text(args[field]);
    if (value !== null) return clip(value);
  }
  const action = text(args['action']);
  if (action !== null) {
    const about = ABOUT_FIELDS.map((field) => text(args[field])).find((value) => value !== null) ?? null;
    return clip(about === null ? action : `${action} · ${about}`);
  }
  const strings = Object.values(args).filter((value): value is string => typeof value === 'string');
  return strings.length === 1 ? clip(text(strings[0])) : null;
}

/**
 * A string worth showing, on one line: newlines and runs of space collapse,
 * because a gist is one line whatever the command looked like.
 */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat === '' ? null : flat;
}

function clip(value: string | null): string | null {
  if (value === null) return null;
  return value.length > GIST_MAX ? `${value.slice(0, GIST_MAX - 1)}…` : value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
