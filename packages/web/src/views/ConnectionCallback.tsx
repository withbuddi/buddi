/**
 * `/connections/callback`: where a connected service's consent page sends the
 * owner back (docs/connections.md). This tab hands the answer to the gateway,
 * which checks the state against the dashboard session that started the
 * sign-in, spends it once, and keeps the tokens in the vault; then it tells
 * the tab that is waiting and closes itself.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { ButtonLink, Notice, Stack } from '../ui';
import { CONNECTIONS_CHANNEL } from './Connections';

export function ConnectionCallback({ search = location.search }: { search?: string }): JSX.Element {
  const [outcome, setOutcome] = useState<{ ok: true; name: string } | { ok: false; message: string } | null>(null);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const params = new URLSearchParams(search);
    // The code leaves the address bar before anything else happens.
    try { history.replaceState(null, '', location.pathname); } catch { /* not in a browser */ }
    const state = params.get('state') ?? '';
    const code = params.get('code') ?? undefined;
    const error = params.get('error') ?? undefined;
    api.connectionCallback({ state, ...(code ? { code } : {}), ...(error ? { error } : {}) })
      .then((done) => {
        setOutcome({ ok: true, name: done.name });
        try {
          const channel = new BroadcastChannel(CONNECTIONS_CHANNEL);
          channel.postMessage({ id: done.id });
          channel.close();
        } catch { /* an older browser: the other tab notices by asking */ }
        window.setTimeout(() => { try { window.close(); } catch { /* not ours to close */ } }, 1500);
      })
      .catch((failure: unknown) => setOutcome({ ok: false, message: failure instanceof Error ? failure.message : String(failure) }));
  }, [search]);
  return (
    <main className="ui-page connections-callback">
      <Stack gap="lg">
        <h2 className="ui-page-title">Connections</h2>
        {outcome === null ? <Notice tone="accent" role="status">Finishing the sign-in…</Notice> : null}
        {outcome?.ok ? (
          <Notice tone="good" role="status" title={`Signed in to ${outcome.name}`}>
            buddi keeps the sign-in in its vault. You can close this tab; the other one carries on.
          </Notice>
        ) : null}
        {outcome && !outcome.ok ? <Notice tone="critical" role="alert" title="Nothing was connected">{outcome.message}</Notice> : null}
        {outcome ? <ButtonLink href="/#/settings/connections">Back to Connections</ButtonLink> : null}
      </Stack>
    </main>
  );
}
