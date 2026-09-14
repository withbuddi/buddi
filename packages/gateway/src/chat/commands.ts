/**
 * What the owner can type, as data.
 *
 * The command table is a list, not a `switch`: `/help`, the tab completer and
 * the dispatcher all read the same rows, so a command cannot exist in one of
 * them and be missing from the other two. Everything here is pure — parsing,
 * accumulating a multi-line paste, recognizing a path — which is why the whole
 * surface can be tested without a terminal.
 */
import path from 'node:path';

export interface CommandSpec {
  /** With the leading slash, as it is typed. */
  name: string;
  /** Argument placeholder, for `/help` and nothing else. */
  args?: string;
  summary: string;
}

/**
 * Every slash command, in the order `/help` prints them: talking first, then
 * the things the owner looks at, then the session itself.
 */
export const COMMANDS: readonly CommandSpec[] = [
  { name: '/help', summary: 'this list' },
  { name: '/agents', summary: 'every agent, with its handle, provider and availability' },
  { name: '/use', args: '<handle|id>', summary: 'switch the agent this session talks to' },
  { name: '/whoami', summary: 'which agent is active, and who you are to it' },
  { name: '/new', summary: 'start a fresh conversation with the active agent' },
  { name: '/resume', args: '[n]', summary: 'pick up a recent conversation with the active agent' },
  { name: '/id', summary: 'the conversation id this session is writing to' },
  { name: '/tools', summary: "the tools the active agent is granted" },
  { name: '/model', summary: 'provider, model and credential kind for the active agent' },
  { name: '/usage', summary: 'tokens and estimated cost for this session' },
  { name: '/status', summary: 'where you stand right now' },
  { name: '/recap', summary: 'run the recap mission now' },
  { name: '/reminders', args: '[cancel <id>]', summary: 'what the agents put on the clock' },
  { name: '/files', args: '[n]', summary: 'the files this installation has stored' },
  { name: '/attach', args: '<path>', summary: 'attach a file to your next message' },
  { name: '/approvals', summary: 'anything waiting for your approval' },
  { name: '/approve', args: '<id>', summary: 'approve a pending action and run it' },
  { name: '/reject', args: '<id>', summary: 'reject a pending action' },
  { name: '/devices', summary: 'the devices paired to this installation' },
  { name: '/clear', summary: 'clear the screen (the conversation is untouched)' },
  { name: '/quit', summary: 'leave (so does Ctrl-D)' },
];

/** `/exit` is not advertised, but nobody should have to learn that. */
export const COMMAND_ALIASES: Record<string, string> = {
  '/exit': '/quit',
  '/q': '/quit',
  '/?': '/help',
};

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);

export interface ParsedCommand {
  /** Canonical name, aliases resolved, lower-cased. */
  name: string;
  /** Everything after the command word, trimmed. May be empty. */
  arg: string;
}

/** A line the owner typed, if it is a command at all. */
export function parseCommand(line: string): ParsedCommand | undefined {
  const text = line.trim();
  if (!text.startsWith('/')) return undefined;
  const match = /^(\/\S*)\s*([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const raw = (match[1] as string).toLowerCase();
  return { name: COMMAND_ALIASES[raw] ?? raw, arg: (match[2] as string).trim() };
}

export function isKnownCommand(name: string): boolean {
  return COMMAND_NAMES.includes(name);
}

/** What an unknown slash command is answered with. Never an error. */
export function unknownCommandText(name: string): string {
  return `${name} is not a command here. Send /help for the list.`;
}

/**
 * `/help`, rendered. Two columns, aligned, so the list is scannable — the
 * widest command decides the gutter rather than a hard-coded number.
 */
export function helpText(): string {
  const left = (c: CommandSpec): string => `${c.name}${c.args ? ` ${c.args}` : ''}`;
  const gutter = COMMANDS.reduce((max, c) => Math.max(max, left(c).length), 0) + 2;
  return [
    'buddi in the terminal. Just write your question, or:',
    '',
    ...COMMANDS.map((c) => `  ${left(c).padEnd(gutter)}${c.summary}`),
    '',
    '@handle …   ask that agent this one message without switching',
    'A line ending in \\ continues; """ on its own opens and closes a block.',
    'Ctrl-C cancels a run in flight; Ctrl-C on an empty line, or Ctrl-D, exits.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Multi-line input
 * ------------------------------------------------------------------ */

/**
 * What one physical line did to the buffer.
 *
 * `literal` marks text that came out of a `"""` block: pasted content, to be
 * sent as written. A line starting with `/` inside one is a line of a file, not
 * a command, and the session must not read it as one.
 */
export type FeedResult =
  | { kind: 'pending' }
  | { kind: 'submit'; text: string; literal: boolean };

/**
 * A paste is not a conversation.
 *
 * Two ways to write more than one line, and they cover the two things people
 * actually do: a trailing backslash for a sentence that ran long, and a `"""`
 * block for pasting something with its own line breaks — a stack trace, a CSV
 * header, an email. Inside a block nothing is interpreted: a line starting with
 * `/` is text, not a command, which is exactly what pasting means.
 */
export class MultilineInput {
  #lines: string[] = [];
  #block = false;
  #continued = false;

  /** True while the next line belongs to something already started. */
  get active(): boolean {
    return this.#block || this.#continued;
  }

  /** True inside a `"""` block, where nothing is interpreted. */
  get inBlock(): boolean {
    return this.#block;
  }

  /** What the prompt should show while a continuation is open. */
  get continuation(): string {
    return this.#block ? '"""' : '…';
  }

  /** Drop everything buffered (Ctrl-C at the prompt). */
  reset(): void {
    this.#lines = [];
    this.#block = false;
    this.#continued = false;
  }

  feed(line: string): FeedResult {
    if (this.#block) {
      if (line.trim() === '"""') {
        const text = this.#lines.join('\n');
        this.reset();
        return { kind: 'submit', text, literal: true };
      }
      this.#lines.push(line);
      return { kind: 'pending' };
    }

    if (!this.#continued && line.trim() === '"""') {
      this.#block = true;
      return { kind: 'pending' };
    }

    // A trailing backslash continues. `\\` at the end is an escaped backslash
    // and ends the line, so a Windows path is not mistaken for a continuation.
    const continues = /(?<!\\)\\$/.test(line);
    this.#lines.push(continues ? line.slice(0, -1) : line);
    if (continues) {
      this.#continued = true;
      return { kind: 'pending' };
    }
    const text = this.#lines.join('\n');
    this.reset();
    return { kind: 'submit', text, literal: false };
  }
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/** `~/Downloads/x.pdf` → an absolute path. Only a leading `~` is expanded. */
export function expandHome(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return input;
}

/** Strip one matching pair of surrounding quotes, as a shell would. */
export function unquote(input: string): string {
  const text = input.trim();
  if (text.length >= 2) {
    const first = text[0];
    if ((first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1);
  }
  return text;
}

export interface PathDetectionOptions {
  home: string;
  /** Injected so the rule is testable without touching a disk. */
  exists: (candidate: string) => boolean;
  /** Where a relative path is resolved from. Defaults to the process cwd. */
  cwd?: string;
}

/**
 * Is this whole message just a file the owner dropped in?
 *
 * Narrow on purpose. One token, no spaces unless it was quoted, and the file
 * has to actually be there — so `budget.csv` typed as a question ("what is in
 * budget.csv?") is a question, and a dragged-in path is an offer to attach.
 * The answer is never acted on here: the session *asks*.
 */
export function attachmentCandidate(
  line: string,
  opts: PathDetectionOptions,
): string | undefined {
  const raw = line.trim();
  // `@handle …` addresses an agent; an absolute path is *not* excluded, so the
  // caller checks its command table first and falls through to here.
  if (raw === '' || raw.startsWith('@')) return undefined;
  const quoted = raw !== unquote(raw);
  const token = unquote(raw);
  if (token === '') return undefined;
  if (!quoted && /\s/.test(token)) return undefined;
  // A bare word with no separator at all is prose, not a path.
  if (!token.includes('/') && !token.includes('.')) return undefined;
  const expanded = expandHome(token, opts.home);
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(opts.cwd ?? process.cwd(), expanded);
  return opts.exists(absolute) ? absolute : undefined;
}

/** `Attach ~/Downloads/x.pdf? [Y/n]` — the question, with the path as typed. */
export function attachQuestion(display: string): string {
  return `Attach ${display}? [Y/n] `;
}

/** A yes-by-default answer: empty, `y`, `yes`. */
export function saidYes(answer: string): boolean {
  const value = answer.trim().toLowerCase();
  return value === '' || value === 'y' || value === 'yes';
}
