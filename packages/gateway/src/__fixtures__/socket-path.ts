/**
 * A path a test server can listen on: the file itself on macOS and Linux, a
 * named pipe derived from it on Windows (where node listens on no file path).
 */
import { createHash } from 'node:crypto';

export function socketPath(file: string): string {
  if (process.platform !== 'win32') return file;
  return `\\\\.\\pipe\\buddi-test-${createHash('sha256').update(file).digest('hex').slice(0, 16)}`;
}
