/** The hex SHA-256 of some bytes: how a file is addressed in the Files library. */
import { createHash } from 'node:crypto';

export function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
