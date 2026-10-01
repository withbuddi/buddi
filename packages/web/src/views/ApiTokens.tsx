/**
 * Settings → API tokens (docs/api.md, "Authentication"; the kit's
 * `ApiTokens`): buddi from a script or another program, without the
 * dashboard. The tokens as rows — the name the owner gave it, its last four
 * characters, where it was made and when it was last used, Revoke… on the
 * right. Making one asks what will use it, then shows the token once with
 * Copy; buddi keeps only its fingerprint. Under them, what a token can't do,
 * in the same words docs/api.md uses.
 */
import { useState, type FormEvent } from 'react';
import { ApiError, api, type ApiTokenView } from '../api';
import { fmtDate, fmtRelative } from '../format';
import { AppIcon, Button, Empty, ErrorBanner, Field, List, ListRow, Modal, Notice, Section, Stack, useAsync } from '../ui';

const NAME_MAX = 60;

function failure(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

export function tokenLine(t: ApiTokenView, timezone: string, now = Date.now()): string {
  const made = `made ${fmtDate(new Date(t.createdAt), timezone, { compact: true })} ${t.createdVia === 'cli' ? 'in the terminal' : 'here'}`;
  return `buddi_…${t.hint} · ${made} · ${t.lastUsedAt ? `last used ${fmtRelative(t.lastUsedAt, now)}` : 'never used'}`;
}

/** Ask what will use it, then show the token once. Done is the only way out of the second step. */
function MakeToken({ onClose, onMade }: { onClose: () => void; onMade: () => void }): JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const ready = !busy && name.trim() !== '' && name.trim().length <= NAME_MAX;

  const make = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    api.createApiToken(name.trim())
      .then((answer) => { setMade({ token: answer.token, name: answer.apiToken.name }); onMade(); })
      .catch((err: unknown) => setError(failure(err)))
      .finally(() => setBusy(false));
  };

  if (made) {
    const copy = (): void => {
      void navigator.clipboard?.writeText(made.token).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }).catch(() => undefined);
    };
    return (
      <Modal title={`Token for ${made.name}`} onClose={onClose} foot={<Button variant="accent" onClick={onClose}>Done</Button>}>
        <div className="at-form">
          <div className="at-secret">
            <code className="at-secret-text" aria-label="The token">{made.token}</code>
            <Button size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
          <Notice tone="warning" title="Copy it now">buddi keeps only a fingerprint of it, so it can’t show it again. Lost it? Revoke it and make another.</Notice>
          <p className="at-text">Send it as a header on every request:</p>
          <code className="at-try">{`curl -H "Authorization: Bearer buddi_…" ${location.origin}/api/overview`}</code>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title="Make a token"
      onClose={onClose}
      foot={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!ready} onClick={() => make()}>Make token</Button>
        </>
      )}
    >
      <form className="at-form" onSubmit={make}>
        <p className="at-text">It acts as you on buddi’s HTTP API. Anything a gated tool does still waits for your approval here or on Telegram.</p>
        <Field label="What will use it" hint={`So you can tell tokens apart later. Up to ${NAME_MAX} characters.`}>
          <input autoFocus value={name} maxLength={NAME_MAX} placeholder="Home Assistant" onChange={(e) => { setError(null); setName(e.target.value); }} />
        </Field>
        {error ? <Notice tone="critical">{error}</Notice> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

function RevokeToken({ token, onClose, onRevoked }: { token: ApiTokenView; onClose: () => void; onRevoked: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = (): void => {
    setBusy(true);
    setError(null);
    api.revokeApiToken(token.id)
      .then(() => { onRevoked(); onClose(); })
      .catch((err: unknown) => { setBusy(false); setError(failure(err)); });
  };
  return (
    <Modal
      title={`Revoke “${token.name}”?`}
      onClose={onClose}
      foot={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={revoke}>Revoke</Button>
        </>
      )}
    >
      <p className="at-text">A request carrying it is refused from now on. Whatever uses it stops working until you give it a new token.</p>
      {error ? <Notice tone="critical">{error}</Notice> : null}
    </Modal>
  );
}

export function ApiTokens({ timezone }: { timezone: string }): JSX.Element {
  const read = useAsync(() => api.apiTokens(), []);
  const [making, setMaking] = useState(false);
  const [revoking, setRevoking] = useState<ApiTokenView | null>(null);
  const tokens = read.data?.tokens ?? [];
  return (
    <Stack gap="lg">
      <p className="ui-page-lede">Let a script or another program use buddi without the dashboard. A token acts as you, minus the decisions only you make here.</p>
      <ErrorBanner message={read.error ? 'Couldn’t read the API tokens.' : null} />
      <Section
        title="Tokens"
        aside="Kept as a fingerprint · shown once"
        actions={<Button variant="accent" size="sm" onClick={() => setMaking(true)}>Make a token</Button>}
        panel
        flush
      >
        {read.data && tokens.length === 0 ? (
          <Empty title="No tokens yet.">Make one here, or in a terminal with <code className="mono">buddi api-token create &lt;name&gt;</code>.</Empty>
        ) : (
          <List>
            {tokens.map((t) => (
              <ListRow
                key={t.id}
                lead={<AppIcon icon="key" />}
                title={t.name}
                sub={tokenLine(t, timezone)}
                side={<Button size="sm" variant="ghost" onClick={() => setRevoking(t)}>Revoke…</Button>}
              />
            ))}
          </List>
        )}
      </Section>
      <Section title="What a token can’t do" panel>
        <ul className="at-cant">
          <li>Approve anything, or make a change where your click is the approval. It can reject.</li>
          <li>Change what an agent may do without asking: its tools, who it hands work to, a connection given out, an “Always”.</li>
          <li>Install or run code buddi hasn’t run before: plugins, upgrades, program connections.</li>
          <li>Change how buddi is reached or unlocked — PIN, Tailscale, Telegram pairing, other tokens — or restore a backup.</li>
          <li>Read or store a secret: owner secrets, model account keys, the backup passphrase.</li>
        </ul>
        <p className="at-foot">
          In a terminal: <code className="mono">buddi api-token create</code>, <code className="mono">list</code>, <code className="mono">revoke</code>. Every route, and which a token may call: docs/api.md.
        </p>
      </Section>
      {making ? <MakeToken onClose={() => setMaking(false)} onMade={() => read.reload()} /> : null}
      {revoking ? <RevokeToken token={revoking} onClose={() => setRevoking(null)} onRevoked={() => read.reload()} /> : null}
    </Stack>
  );
}
