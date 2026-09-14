/**
 * What the terminal can do, decided once.
 *
 * Every other module in `chat/` takes a `TerminalStyle` and renders against it
 * rather than reading `process.stdout` for itself. That is what makes the
 * renderer, the spinner and the session testable without a TTY: a pipe, a CI
 * job and `NO_COLOR=1` are the same thing here — `{ color: false }` — and no
 * test ever has to allocate a pseudo-terminal to assert what the owner sees.
 */

/** The two facts about the output device anything here needs. */
export interface TerminalStyle {
  /** ANSI is allowed: a TTY, with `NO_COLOR` unset. */
  color: boolean;
  /** Columns to wrap and align to. 80 when the device does not say. */
  width: number;
  /** A TTY at all — separate from colour, because `NO_COLOR` kills only one. */
  tty: boolean;
}

/** The narrow slice of `process.stdout` this module reads. */
export interface StreamLike {
  isTTY?: boolean;
  columns?: number;
}

export const DEFAULT_WIDTH = 80;
/** Beyond this, prose stops being readable; tables still use the full width. */
export const MAX_PROSE_WIDTH = 100;

/**
 * `NO_COLOR` is honoured as the standard says: *set at all*, even empty, means
 * no colour. A pipe gets no colour either — the bytes are going to a file, a
 * grep or another program, and escape codes are noise there.
 */
export function styleFor(
  env: NodeJS.ProcessEnv = process.env,
  stream: StreamLike = process.stdout,
): TerminalStyle {
  const tty = stream.isTTY === true;
  const noColor = env.NO_COLOR !== undefined;
  const forced = (env.FORCE_COLOR ?? '').trim();
  const color = noColor ? false : forced !== '' && forced !== '0' ? true : tty;
  const columns = Number(stream.columns ?? 0);
  return {
    color,
    width: Number.isFinite(columns) && columns > 20 ? Math.trunc(columns) : DEFAULT_WIDTH,
    tty,
  };
}

const ESC = '\u001b[';

/** `\u001b[1m…\u001b[22m` — a scoped reset, so nesting cannot leak. */
function wrap(open: string, close: string, text: string, color: boolean): string {
  return color ? `${ESC}${open}m${text}${ESC}${close}m` : text;
}

export const bold = (s: string, color = true): string => wrap('1', '22', s, color);
export const dim = (s: string, color = true): string => wrap('2', '22', s, color);
export const italic = (s: string, color = true): string => wrap('3', '23', s, color);
export const bright = (s: string, color = true): string => wrap('1;36', '0', s, color);
export const green = (s: string, color = true): string => wrap('32', '39', s, color);
export const red = (s: string, color = true): string => wrap('31', '39', s, color);
export const yellow = (s: string, color = true): string => wrap('33', '39', s, color);

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** The text without its escape codes — what the eye actually counts. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Printable width of a string, escape codes excluded. */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** Pad to `width` printable characters. Never truncates. */
export function padEnd(text: string, width: number): string {
  const short = width - visibleWidth(text);
  return short > 0 ? text + ' '.repeat(short) : text;
}

/** Cut to `width` printable characters, with an ellipsis when it had to. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  const plain = stripAnsi(text);
  if (plain.length <= width) return text;
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}
