/**
 * Home after the first backup: the six words that open the backups, once.
 *
 * Not part of first run — nothing is locked with them until a backup exists.
 * The card stays on Home until "I saved it" is pressed (the gateway keeps
 * that, so a reload or another device shows it again until then). After
 * that the words are behind Settings → Backup's Reveal. With a lock-screen
 * PIN set, the gateway does not send the words with the card: it asks for
 * the PIN and reveals them (POST /api/backups/passphrase/reveal).
 */
import { useState } from 'react';
import { api, ApiError } from '../../api';
import { Button, ErrorBanner, Field, Section, Stack, Toolbar, useAsync } from '../../ui';

/** What the card says above the words. */
export const PASSPHRASE_CARD_LINE = 'Write these down; they open your backups and only you have them.';

export function PassphraseCard(): JSX.Element | null {
  const notice = useAsync(() => api.passphraseNotice(), []);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [pin, setPin] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const data = notice.data;
  if (gone || !data || !data.show) return null;
  const phrase = 'passphrase' in data ? data.passphrase : revealed;
  const copy = (): void => {
    if (phrase === null) return;
    void navigator.clipboard.writeText(phrase).then(() => setCopied('done'), () => setCopied('failed'));
  };
  const reveal = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .revealBackupPassphrase(pin)
      .then((answer) => { setRevealed(answer.passphrase); setPin(''); })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  const saved = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .acknowledgePassphrase()
      .then(() => setGone(true))
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return (
    <Section title="Your backup passphrase" panel>
      <Stack gap="sm">
        <ErrorBanner message={failed} />
        <p className="ui-card-meta">{PASSPHRASE_CARD_LINE}</p>
        {phrase !== null ? (
          <>
            <p className="backup-phrase mono" aria-label="Your backup passphrase">{phrase}</p>
            <p className="ui-card-meta">Later, Settings → Backup shows them again behind your PIN.</p>
            <Toolbar align="end">
              <Button onClick={copy}>{copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy'}</Button>
              <Button variant="accent" disabled={busy} onClick={saved}>
                I saved it
              </Button>
            </Toolbar>
          </>
        ) : (
          <>
            <Field label="Your PIN" hint="The one that unlocks this dashboard.">
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && pin !== '') reveal(); }}
              />
            </Field>
            <Toolbar align="end">
              <Button variant="accent" disabled={busy || pin === ''} onClick={reveal}>
                Show the words
              </Button>
            </Toolbar>
          </>
        )}
      </Stack>
    </Section>
  );
}
