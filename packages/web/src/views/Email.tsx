/**
 * Settings → Email.
 *
 * One section today: **Policies**, the standing decisions about incoming mail.
 * Two lists, because they are two different things and reading them as one is
 * how an owner ends up not knowing what is switched on:
 *
 *  - **Applied** — rules that are deciding, right now, with no model run and
 *    nothing to approve each time. Each row says how many triage runs it has
 *    saved, which is the only honest measure of what it is doing for you.
 *  - **Learned, proposed** — what buddi noticed in your own history and would
 *    like to do. These decide nothing. Keep turns one on; Revoke says no.
 *
 * Revoke is on both lists on purpose: a rule that is on must be one tap from
 * off, and "one tap to undo" is what earns the right to apply a learned ignore
 * without asking first (docs/email.md §3).
 */
import { useState } from 'react';
import { api, type EmailPolicy } from '../api';
import { fmtRelative } from '../format';
import { Button, Empty, ErrorBanner, List, ListRow, Notice, PageFrame, Panel, Pill, Toolbar, useAsync, type Tone } from '../ui';

export function Email({ embedded }: { embedded?: boolean }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.emailPolicies(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const act = (id: string, run: () => Promise<unknown>) => (): void => {
    setBusy(id);
    setFailed(null);
    void run()
      .then(() => reload())
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  const applied = data?.applied ?? [];
  const proposed = data?.proposed ?? [];
  const saved = applied.reduce((n, p) => n + p.runsSaved, 0);

  return (
    <PageFrame embedded={embedded} title="Email">
      <ErrorBanner message={error ?? failed} />
      <Notice>
        A policy is a decision made once. The next message from that sender is handled by the rule
        instead of by a model run, and what each rule did is recorded so you can audit the silence.
        {saved > 0 ? ` So far they have saved ${saved} triage run${saved === 1 ? '' : 's'}.` : ''}
      </Notice>

      <Panel title="Policies" flush>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : applied.length === 0 ? (
          <Empty>No policies are deciding anything yet. buddi proposes them from your own mail.</Empty>
        ) : (
          <List>
            {applied.map((p) => (
              <ListRow
                key={p.id}
                lead={<Pill tone={toneFor(p.action)}>{p.action}</Pill>}
                title={p.matcher}
                sub={subFor(p)}
                side={
                  <Toolbar align="end">
                    <Button onClick={act(p.id, () => api.revokeEmailPolicy(p.id))} disabled={busy === p.id}>
                      Revoke
                    </Button>
                  </Toolbar>
                }
              />
            ))}
          </List>
        )}
      </Panel>

      <Panel title="Learned, proposed" flush>
        {!data ? (
          <Empty>Loading…</Empty>
        ) : proposed.length === 0 ? (
          <Empty>Nothing proposed. A sender needs three verdicts running before buddi suggests a rule.</Empty>
        ) : (
          <List>
            {proposed.map((p) => (
              <ListRow
                key={p.id}
                lead={<Pill tone="muted">{p.action}</Pill>}
                title={p.matcher}
                sub={subFor(p)}
                side={
                  <Toolbar align="end">
                    <Button onClick={act(p.id, () => api.revokeEmailPolicy(p.id))} disabled={busy === p.id}>
                      Revoke
                    </Button>
                    <Button
                      variant="accent"
                      onClick={act(p.id, () => api.keepEmailPolicy(p.id))}
                      disabled={busy === p.id}
                    >
                      Keep
                    </Button>
                  </Toolbar>
                }
              />
            ))}
          </List>
        )}
      </Panel>
    </PageFrame>
  );
}

/** The one line under a rule: where it came from, and what it has done. */
export function subFor(policy: EmailPolicy): string {
  const parts = [`${policy.scope}, ${originWord(policy.origin)}`];
  if (policy.learnedFrom > 0) parts.push(`from ${policy.learnedFrom} verdicts`);
  parts.push(
    policy.proposed
      ? 'deciding nothing yet'
      : policy.runsSaved === 0
        ? 'no runs saved yet'
        : `${policy.runsSaved} run${policy.runsSaved === 1 ? '' : 's'} saved`,
  );
  if (policy.createdAt) parts.push(fmtRelative(policy.createdAt));
  return parts.join(' · ');
}

export function originWord(origin: string): string {
  if (origin === 'owner') return 'you decided it';
  if (origin === 'learned') return 'learned from your mail';
  return 'from a plugin';
}

export function toneFor(action: string): Tone | undefined {
  if (action === 'ignore') return 'muted';
  if (action === 'notify' || action === 'draft') return 'accent';
  if (action === 'hand-to-agent') return 'good';
  return undefined;
}
