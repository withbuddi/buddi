/**
 * Failed IMAP logins, per mailbox.
 *
 * Core records each use of a mailbox's password, and a use that delivered the
 * value is a success as far as it knows. The provider can still refuse that
 * value at login — an app password revoked at Google, a typo kept from before
 * the Set password check existed — and until now nothing said so but a log
 * line. The poll (and every mailbox action) writes the refusal here, on the
 * account row; the next login that works clears it, and so does Set password.
 * The Email settings row reads it as "Password needed" (`pages/queries.ts`).
 */
import type { DbArea } from '@buddi/core/plugin';

type Db = Pick<DbArea, 'query'>;

/** How much of the server's sentence is kept. It names no secret; it is cut anyway. */
const MAX_ERROR = 300;

/**
 * Whether an error is the server refusing the credentials, as opposed to a
 * network failure or a timeout. `imapflow` flags it; other servers only say
 * it in words, so the common sentences are matched too.
 */
export function isAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { authenticationFailed?: unknown; message?: unknown; responseText?: unknown; serverResponseCode?: unknown };
  if (e.authenticationFailed === true) return true;
  if (typeof e.serverResponseCode === 'string' && /^AUTHENTICATIONFAILED$/i.test(e.serverResponseCode)) return true;
  const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.responseText === 'string' ? e.responseText : ''}`;
  return /AUTHENTICATIONFAILED|invalid credentials|authentication failed|login failed|LOGIN Bad|username and password not accepted/i.test(text);
}

/** The server's reason, in one short line, for the settings page. */
function reasonOf(err: unknown): string {
  const e = err as { responseText?: unknown; message?: unknown };
  const raw = typeof e?.responseText === 'string' && e.responseText.trim() !== ''
    ? e.responseText
    : err instanceof Error ? err.message : String(err);
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR);
}

export async function recordLoginFailure(db: Db, accountId: string, err: unknown, now: Date): Promise<void> {
  await db.query(
    `update email.accounts set login_failed_at = $2, login_error = $3 where id = $1::uuid`,
    [accountId, now, reasonOf(err)],
  );
}

/** A login worked. Cheap when there was nothing to clear. */
export async function clearLoginFailure(db: Db, accountId: string): Promise<void> {
  await db.query(
    `update email.accounts set login_failed_at = null, login_error = null
      where id = $1::uuid and login_failed_at is not null`,
    [accountId],
  );
}
