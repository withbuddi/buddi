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

/** First run as the shell read it: finished (done or skipped), still open, or not read yet. */
export type OnboardingPhase = 'done' | 'open' | 'unknown';

/** Where this device keeps whether the handover's progress had a plugin waiting for a restart. */
export const HANDOVER_WAKES_KEY = 'buddi.handoverWakes';

/** Keep whether these plugins have one waiting for a restart. Never throws. */
export function noteHandoverWakes(plugins: readonly TakeOnPlugin[]): void {
  try {
    window.localStorage.setItem(HANDOVER_WAKES_KEY, waitingForRestart(plugins).length > 0 ? '1' : '0');
  } catch {
    /* storage refused: Home reads the progress again, which is only slower */
  }
}

/** Whether the handover's progress is known to have had nothing waiting. */
function handoverHadNoWakes(): boolean {
  try {
    return window.localStorage.getItem(HANDOVER_WAKES_KEY) === '0';
  } catch {
    return false;
  }
}

/**
 * The notice. Given `plugins` (the handover has the progress already) it draws
 * those; without, it reads the progress once itself (Home).
 *
 * Only first run's take-on marks a plugin `wakesOnRestart`. So once first run
 * is finished and its progress was seen with nothing waiting, Home does not
 * ask again: there is nothing left that could appear. Until the shell has
 * read first run's state, it waits rather than ask early.
 */
export function WakesAfterRestart({ plugins, onboarding = 'open' }: { plugins?: readonly TakeOnPlugin[]; onboarding?: OnboardingPhase }): JSX.Element | null {
  const [read, setRead] = useState<TakeOnPlugin[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (plugins !== undefined) {
      // An empty list may only be progress not read yet: Home finds out itself.
      if (plugins.length > 0) noteHandoverWakes(plugins);
      return undefined;
    }
    if (onboarding === 'unknown') return undefined;
    if (onboarding === 'done' && handoverHadNoWakes()) {
      setRead([]);
      return undefined;
    }
    let cancelled = false;
    Promise.resolve()
      .then(() => api.takeOnProgress())
      .then((view) => {
        if (cancelled) return;
        const found = view?.plugins ?? [];
        setRead(found);
        if (onboarding === 'done') noteHandoverWakes(found);
      })
      .catch(() => { if (!cancelled) setRead([]); });
    return () => {
      cancelled = true;
    };
  }, [plugins, onboarding]);
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
