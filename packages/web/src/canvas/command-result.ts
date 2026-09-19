/** Recognize execution data by shape, independent of the tool producing it. */
export interface CommandResultView {
  command: string | null;
  result: Record<string, unknown> & { state: string; stdout: string; stderr: string; exitCode: number | null };
  input: Record<string, unknown> | null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function commandResult(value: unknown): CommandResultView | null {
  const root = record(value);
  if (!root) return null;
  const output = record(root.output) ?? root;
  if (typeof output.state !== 'string' || typeof output.stdout !== 'string' || typeof output.stderr !== 'string'
    || !(output.exitCode === null || (typeof output.exitCode === 'number' && Number.isFinite(output.exitCode)))) return null;
  const input = output === root ? null : record(root.input);
  const command = input?.command ?? output.command;
  return { command: typeof command === 'string' ? command : null, input,
    result: output as CommandResultView['result'] };
}
