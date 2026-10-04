/**
 * "Save this login for amazon.com?" — the small card above the Page tab's
 * window when the owner signs in on a page they hold (docs/browser.md,
 * "Saving a sign-in"). For a login already kept with that user name and a
 * password buddi hasn't seen: "Update the login for amazon.com?".
 *
 * buddi saw the sign-in go out; the password waits in the browser host for two
 * minutes and never comes here. This card has the site and the user name, and
 * three answers: Save (or Update; kept under Keys and secrets, where agents
 * fill it without seeing it), Not now, and Never for this site. What became
 * of a Save is what the route answered: "Saved" for two seconds, or why not
 * with Try again. It goes by itself when the two minutes are up, because the
 * password has gone by then.
 */
import { useEffect, useState } from 'react';
import { api, type LoginDecision, type LoginSeen } from '../../api';
import { Button, Notice, Toolbar } from '../../ui';
import { settingsRoute } from '../../routes';
import { shortUsername } from '../../views/secret-rules';

/** How long the host holds the password; the card does not outlive it. */
export const LOGIN_CARD_MS = 2 * 60_000;
/** How long "Saved" stays before the card goes. */
export const SAVED_MS = 2_000;

export function SaveLoginCard({ login, onDone }: { login: LoginSeen; onDone: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  /** Why the Save did not land, and whether trying again can help (a question no longer held cannot). */
  const [failure, setFailure] = useState<{ reason: string; retry: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setSaved(false);
    setFailure(null);
    const timer = window.setTimeout(onDone, LOGIN_CARD_MS);
    return () => window.clearTimeout(timer);
  }, [login.id]);
  useEffect(() => {
    if (!saved) return undefined;
    const timer = window.setTimeout(onDone, SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);
  const answer = async (decision: LoginDecision): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.browserLogin(login.id, decision);
      if (decision === 'save' && result.outcome === 'saved') { setSaved(true); return; }
      if (decision === 'save' && result.outcome === 'gone') { setFailure({ reason: 'That sign-in is no longer held. Add it in Keys and secrets.', retry: false }); return; }
      onDone();
    } catch (error) {
      setFailure({ reason: error instanceof Error ? error.message : String(error), retry: decision === 'save' });
    } finally {
      setBusy(false);
    }
  };
  const update = login.update === true;
  if (saved) {
    return (
      <Notice tone="good" role="status" title={update ? `Updated the login for ${login.site}` : `Saved the login for ${login.site}`}>
        Agents can sign in there now without seeing it. It’s under <a className="wb-link" href={settingsRoute('secrets')}>Keys and secrets</a>.
      </Notice>
    );
  }
  const who = login.username ? `For ${shortUsername(login.username)}. ` : '';
  return (
    <section className="br-login" data-testid="save-login" aria-label={update ? 'Update this login' : 'Save this login'}>
      <Notice
        tone="accent"
        role="status"
        title={update ? `Update the login for ${login.site}?` : `Save this login for ${login.site}?`}
        action={
          <Toolbar align="end">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void answer('never')}>Never for this site</Button>
            <Button size="sm" disabled={busy} onClick={() => void answer('later')}>Not now</Button>
            <Button size="sm" variant="accent" disabled={busy} onClick={() => void answer('save')}>{update ? 'Update' : 'Save'}</Button>
          </Toolbar>
        }
      >
        {update
          ? `${who}buddi replaces the password it keeps under Keys and secrets with the one you just used.`
          : `${who}buddi keeps it under Keys and secrets, and agents use it without ever seeing it.`}
      </Notice>
      {failure ? (
        <Notice
          tone="critical"
          role="alert"
          action={failure.retry ? <Button size="sm" disabled={busy} onClick={() => void answer('save')}>Try again</Button> : undefined}
        >
          {failure.reason}
        </Notice>
      ) : null}
    </section>
  );
}
