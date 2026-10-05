/**
 * A plugin first run installed that this buddi could not load without a
 * restart: "Calendar is installed; it wakes up after a restart", with the
 * Restart button, on the handover card and on Home.
 *
 * Read from chapter 3's own progress (`GET /api/onboarding/take-on`): the
 * gateway marks a plugin `wakesOnRestart` only when loading it live did not
 * work, and a restart forgets the mark, so the line leaves once it is true.
 * The restart is the supervisor's, under "Restarting buddi", which reloads the
 * page when buddi is back.
 */
import { useEffect, useState } from 'react';
import { api, ApiError, type TakeOnPlugin } from '../../api';
import { restartWhile } from '../../shell/restart';
import { Button, Notice } from '../../ui';

/** "Calendar", "Calendar and Weather", "Calendar, Weather and Image". */
function titles(plugins: readonly TakeOnPlugin[]): string {
  const names = plugins.map((p) => p.title);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The plugins installed and waiting for a restart. */
export function waitingForRestart(plugins: readonly TakeOnPlugin[] | undefined): TakeOnPlugin[] {
  return (plugins ?? []).filter((p) => p.state === 'ready' && p.wakesOnRestart === true);
}

/** The sentence, the server's own words. */
export function wakesSentence(plugins: readonly TakeOnPlugin[]): string {
  return `${titles(plugins)} ${plugins.length === 1 ? 'is' : 'are'} installed; ${plugins.length === 1 ? 'it wakes' : 'they wake'} up after a restart.`;
}

/**
 * The notice. Given `plugins` (the handover has the progress already) it draws
 * those; without, it reads the progress once itself (Home).
 */
export function WakesAfterRestart({ plugins }: { plugins?: readonly TakeOnPlugin[] }): JSX.Element | null {
  const [read, setRead] = useState<TakeOnPlugin[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (plugins !== undefined) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.takeOnProgress())
      .then((view) => { if (!cancelled) setRead(view?.plugins ?? []); })
      .catch(() => { if (!cancelled) setRead([]); });
    return () => {
      cancelled = true;
    };
  }, [plugins]);
  const waiting = waitingForRestart(plugins ?? read ?? []);
  if (waiting.length === 0) return null;
  const restart = (): void => {
    setBusy(true);
    setFailed(null);
    void restartWhile({ kind: 'plugins', line: `Loading ${titles(waiting)}…` }, () => api.serviceAction('restart'))
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return (
    <Notice
      tone="accent"
      role="status"
      action={
        <Button size="sm" variant="accent" disabled={busy} onClick={restart}>
          Restart
        </Button>
      }
    >
      {wakesSentence(waiting)}
      {failed ? ` ${failed.replace(/[.\s]+$/, '')}.` : ' It takes a few seconds, and this page comes back by itself.'}
    </Notice>
  );
}
