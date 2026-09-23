/**
 * What a tool row may unfold into, under itself, without leaving the chat.
 *
 * Two kinds of result are worth reading in place: a change to a file, which is
 * its diff, and a command, which is what it printed. Everything else opens on
 * the canvas as before — a row that unfolds into a JSON dump is not an
 * improvement on one that opens into a panel.
 *
 * Recognised **by shape**, like everything else in this package: a result
 * with a `diff` string is a change; a result that names its `command` and
 * carries what it printed (`plain`), how it ended (`exitCode`) or the process
 * it left running (`pid`) is a command. The tool's name is not consulted.
 *
 * Only fields that are already for a person are read: a `diff`, and a
 * command's `plain` — its output with the model's fence markers and the
 * terminal's colour codes gone. Never `text`: that is the fenced copy written
 * for the model, and the markers in it are a contract with the model, not
 * something for the owner to read around. A command whose result has no
 * `plain` unfolds into its command line alone.
 */

export type ToolBody =
  | { kind: 'diff'; diff: string }
  | {
      kind: 'command';
      command: string;
      output: string | null;
      exitCode: number | null;
      elapsedMs: number | null;
    };

export function toolBodyFor(output: unknown): ToolBody | null {
  const result = record(output);
  if (!result) return null;
  const diff = string(result['diff']);
  if (diff !== null) return { kind: 'diff', diff };
  const command = string(result['command']);
  const printed = string(result['plain']);
  const exitCode = finite(result['exitCode']);
  if (command !== null && (printed !== null || exitCode !== null || finite(result['pid']) !== null)) {
    return { kind: 'command', command, output: printed, exitCode, elapsedMs: finite(result['elapsedMs']) };
  }
  return null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
