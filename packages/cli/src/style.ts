/**
 * Colour for the binary's own output: only on a terminal, never with
 * `NO_COLOR` set (at all, even empty, as the convention says).
 */
import type { HelpStyle } from './commands.js';

export interface OutputStream {
  isTTY?: boolean;
}

export function colorOn(
  env: NodeJS.ProcessEnv = process.env,
  stream: OutputStream = process.stdout,
): boolean {
  return stream.isTTY === true && env.NO_COLOR === undefined;
}

const wrap = (open: string, close: string, text: string, on: boolean): string =>
  on ? `\u001b[${open}m${text}\u001b[${close}m` : text;

export const bold = (text: string, on: boolean): string => wrap('1', '22', text, on);
export const dim = (text: string, on: boolean): string => wrap('2', '22', text, on);

export function helpStyle(on: boolean): HelpStyle {
  return { bold: (t) => bold(t, on), dim: (t) => dim(t, on) };
}
