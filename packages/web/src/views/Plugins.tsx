/**
 * Settings → Plugins: what is installed, and the two yeses that install one.
 *
 * A plugin is somebody else's code running inside buddi with everything buddi
 * can do, so this page is shaped around reading before agreeing rather than
 * around a list with an install button. The trust sentence sits at the top and
 * is never paraphrased. Typing a package name *stages* it — fetched, hashed and
 * read, never imported — and what comes back is a card of facts: who published
 * it, the hash, how many dependencies arrived and which of them run scripts,
 * and what the package's own prose claims it owns and talks to.
 *
 * "Install" sends that hash back, so an approval can only ever mean the package
 * that was read about. If the plan then finds the prose and the manifest
 * disagreeing, a second card lists the differences and "Install anyway" is the
 * only thing that acknowledges them; the first approval never can.
 *
 * Loading a newly installed plugin needs a restart, which is the supervisor's
 * job. A checkout has no supervisor, so it gets the command instead.
 */
import { useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type InstalledPluginView,
  type PluginJob,
  type PluginPlan,
  type PluginSource,
  type PluginUnlock,
  type StagedPluginView,
} from '../api';
import { fmtRelative } from '../format';
import { AGENTS_ROUTE } from '../routes';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  Field,
  KV,
  Notice,
  Panel,
  Pill,
  Section,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';

/** How often a running stage is asked where it has got to. */
const JOB_POLL_MS = 1_500;

/** What each phase of a stage is, in the words of the thing being waited for. */
const PHASE_WORDS: Record<PluginJob['phase'], string> = {
  fetching: 'Fetching the package.',
  'installing-dependencies': 'Installing its dependencies. Nothing of the plugin has run.',
  reading: 'Reading what it says it is.',
  done: 'Read. Nothing has been imported yet.',
  failed: 'That did not work.',
};

/** The one line a checkout gets instead of a restart button. */
const CHECKOUT_RESTART = 'Restart buddi to load it. In a checkout, stop it and run: buddi serve';

/** A source, in one readable phrase. */
function sourceWords(source: PluginSource): string {
  if (source.kind === 'registry') return `npm · ${source.name}@${source.version}`;
  if (source.kind === 'tarball') return `a file on this machine · ${source.path}`;
  return `a directory on this machine · ${source.path}`;
}

/** A stage watched to its end. */
function useStageJob(id: string | null): { job: PluginJob | undefined; error: string | null } {
  const [job, setJob] = useState<PluginJob | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) {
      setJob(undefined);
      setError(null);
      return undefined;
    }
    let stopped = false;
    const ask = (): void => {
      api
        .pluginJob(id)
        .then((next) => {
          if (stopped) return;
          setJob(next);
          if (next.phase === 'done' || next.phase === 'failed') stopped = true;
        })
        .catch((err: unknown) => {
          if (stopped) return;
          setError(err instanceof ApiError ? err.message : String(err));
          stopped = true;
        });
    };
    ask();
    const timer = window.setInterval(ask, JOB_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [id]);
  return { job, error };
}

export function Plugins(): JSX.Element {
  const view = useAsync(() => api.plugins(), [], 20_000);
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, error: jobError } = useStageJob(jobId);
  const [failed, setFailed] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  // A finished stage puts a card on the page, which comes from the list.
  useEffect(() => {
    if (job?.phase === 'done' || job?.phase === 'failed') view.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.phase]);

  const data = view.data;
  const checkout = data?.checkout ?? true;

  return (
    <Stack gap="lg">
      <ErrorBanner message={view.error ?? failed ?? jobError} />
      {data?.unavailable ? <Notice tone="warning">{data.unavailable}</Notice> : null}

      <Panel title="Plugins">
        <Stack divided>
          <Section>
            {/* Verbatim, and above everything: it is what the two approvals
                underneath are approving. */}
            <Notice tone="warning">{data?.trust ?? ''}</Notice>
          </Section>
          <Section>
            <Install
              busy={job !== undefined && job.phase !== 'done' && job.phase !== 'failed'}
              onStaged={(id) => {
                setFailed(null);
                setInstalled(null);
                setJobId(id);
              }}
              onFailed={setFailed}
            />
          </Section>
          {job ? (
            <Section>
              <Notice
                tone={job.phase === 'failed' ? 'critical' : job.phase === 'done' ? 'good' : undefined}
                role="status"
              >
                {PHASE_WORDS[job.phase]} {job.error ?? ''}
              </Notice>
            </Section>
          ) : null}
        </Stack>
      </Panel>

      {(data?.staged ?? []).map((staged) => (
        <Staged
          key={staged.id}
          staged={staged}
          onInstalled={(name) => {
            setInstalled(name);
            setJobId(null);
            view.reload();
          }}
          onGone={() => view.reload()}
        />
      ))}

      {installed || data?.restartNeeded ? (
        <RestartToLoad checkout={checkout} name={installed} />
      ) : null}

      <Panel title="Installed">
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.installed.length === 0 ? (
          <Empty>Nothing is installed beyond what buddi ships with.</Empty>
        ) : (
          <Stack divided>
            {data.installed.map((plugin) => (
              <Section key={plugin.name}>
                <Installed plugin={plugin} onChanged={() => view.reload()} onFailed={setFailed} />
              </Section>
            ))}
          </Stack>
        )}
      </Panel>
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * Asking for one
 * ------------------------------------------------------------------ */

function Install({
  busy,
  onStaged,
  onFailed,
}: {
  busy: boolean;
  onStaged: (jobId: string) => void;
  onFailed: (message: string) => void;
}): JSX.Element {
  const [spec, setSpec] = useState('');
  const [sending, setSending] = useState(false);
  const go = (): void => {
    setSending(true);
    api
      .stagePlugin(spec.trim())
      .then((answer) => {
        onStaged(answer.job.id);
        setSpec('');
      })
      .catch((error: unknown) => onFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setSending(false));
  };
  return (
    <Stack gap="sm">
      <Field
        label="Install a plugin"
        hint="A package name, a name@version, a path to a .tgz, or a directory you built yourself."
      >
        <input
          type="text"
          value={spec}
          placeholder="buddi-plugin-weather"
          onChange={(event) => setSpec(event.target.value)}
        />
      </Field>
      <Toolbar align="end">
        <Button variant="accent" disabled={busy || sending || spec.trim() === ''} onClick={go}>
          Read it first
        </Button>
      </Toolbar>
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * A staged package, and the two approvals
 * ------------------------------------------------------------------ */

function Staged({
  staged,
  onInstalled,
  onGone,
}: {
  staged: StagedPluginView;
  onInstalled: (name: string) => void;
  onGone: () => void;
}): JSX.Element {
  const [plan, setPlan] = useState<PluginPlan | null>(staged.plan ?? null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /*
   * The hash the card is showing goes back with the approval. The server
   * refuses when it is not the one on disk, which is what stops a click aimed
   * at one package approving another.
   */
  const approve = (acknowledgeDrift: boolean): void => {
    setBusy(true);
    setFailed(null);
    api
      .approveStaged(staged.id, {
        ...(staged.integrity ? { integrity: staged.integrity } : {}),
        ...(acknowledgeDrift ? { acknowledgeDrift: true } : {}),
      })
      .then((answer) => {
        if (answer.installed) onInstalled(staged.name);
        else if (answer.plan) setPlan(answer.plan);
      })
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const reject = (): void => {
    setBusy(true);
    setFailed(null);
    api
      .rejectStaged(staged.id)
      .then(() => onGone())
      .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const drift = plan?.drift ?? [];
  return (
    <Stack gap="lg">
      <Card
        tone="accent"
        title={`${staged.name} ${staged.version}`}
        meta={<Pill tone="muted">read, not installed</Pill>}
      >
        <Stack gap="sm">
          <ErrorBanner message={failed} />
          <KV
            items={[
              { label: 'From', value: sourceWords(staged.source) },
              { label: 'Published by', value: staged.publisher ?? 'nobody npm will name' },
              { label: 'Integrity', value: <span className="mono">{staged.integrity ?? 'none — this came off a disk'}</span> },
              {
                label: 'Dependencies',
                value:
                  staged.dependencies.count === 0
                    ? 'none'
                    : `${staged.dependencies.count}${
                        staged.dependencies.withScripts.length === 0
                          ? ', none of which run install scripts'
                          : `, of which these run install scripts: ${staged.dependencies.withScripts.join(', ')}`
                      }`,
              },
            ]}
          />
          <Section title="What the package says about itself">
            <Stack gap="sm">
              <p className="ui-card-meta">
                This is its claim, taken from its own buddi.md. Nothing has checked it yet.
              </p>
              <KV
                items={[
                  { label: 'Schema it owns', value: staged.claims.schema ?? 'it claims none' },
                  {
                    label: 'Hosts it reaches',
                    value: staged.claims.hosts.length === 0 ? 'it claims none' : staged.claims.hosts.join(', '),
                  },
                ]}
              />
              {staged.claims.missing ? (
                <p className="ui-card-meta">It ships no buddi.md, so it says nothing about itself at all.</p>
              ) : (
                <p className="ui-card-meta">{staged.claims.text}</p>
              )}
            </Stack>
          </Section>
          <Toolbar align="end">
            <Button variant="ghost" disabled={busy} onClick={reject}>
              Not this one
            </Button>
            <Button variant="accent" disabled={busy || drift.length > 0} onClick={() => approve(false)}>
              Install
            </Button>
          </Toolbar>
        </Stack>
      </Card>

      {drift.length > 0 ? (
        <Card
          tone="warning"
          title="What it said, and what it does"
          meta={<Pill tone="warning">read this first</Pill>}
        >
          <Stack gap="sm">
            <p className="ui-card-meta">
              Its prose and its manifest do not agree. Neither is authoritative; the manifest is what
              actually runs.
            </p>
            <ul className="plugin-drift">
              {drift.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <Unlocks unlocks={plan?.agents ?? []} />
            <Toolbar align="end">
              <Button variant="ghost" disabled={busy} onClick={reject}>
                Not this one
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => approve(true)}>
                Install anyway
              </Button>
            </Toolbar>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * After an install
 * ------------------------------------------------------------------ */

/**
 * The restart that actually loads it.
 *
 * A packaged installation restarts the gateway through the supervisor, which
 * is the same button the Service section offers and says the same thing about
 * closing this page. A checkout has no supervisor and gets the command.
 */
function RestartToLoad({ checkout, name }: { checkout: boolean; name: string | null }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const what = name ? `${name} is installed.` : 'Something is installed that this buddi has not loaded.';
  return (
    <Panel title="Restart to load it">
      <Section>
        <Stack gap="sm">
          <ErrorBanner message={failed} />
          <Notice tone={checkout ? 'warning' : undefined} role="status">
            {what} {checkout ? CHECKOUT_RESTART : 'Its tools appear once buddi restarts. That closes this dashboard for a few seconds.'}
          </Notice>
          {checkout ? null : (
            <Toolbar align="end">
              <Button
                variant="accent"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setFailed(null);
                  void api
                    .serviceAction('restart')
                    .catch((error: unknown) => setFailed(error instanceof ApiError ? error.message : String(error)))
                    .finally(() => setBusy(false));
                }}
              >
                Restart to load it
              </Button>
            </Toolbar>
          )}
        </Stack>
      </Section>
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * One installed plugin
 * ------------------------------------------------------------------ */

/** The agents a plugin proposes, and where the owner's copy stands. */
function Unlocks({ unlocks }: { unlocks: PluginUnlock[] }): JSX.Element | null {
  if (unlocks.length === 0) return null;
  return (
    <Section title="Agents it would unlock">
      <Stack gap="sm">
        <KV
          items={unlocks.map((unlock) => ({
            key: unlock.id,
            label: <span className="mono">@{unlock.handle}</span>,
            value: (
              <span>
                <Pill tone={unlock.drift.state === 'up-to-date' ? 'good' : 'warning'}>{unlock.drift.state}</Pill>{' '}
                {unlock.drift.message}
              </span>
            ),
          }))}
        />
        {/* Accepting one is an approval with the whole grant in front of you,
            and that happens where every other agent decision happens. */}
        <p className="ui-card-meta">
          Nothing here is created by installing. <a href={AGENTS_ROUTE}>Accept them on the Agents page</a>,
          one at a time, seeing the whole grant.
        </p>
      </Stack>
    </Section>
  );
}

function Installed({
  plugin,
  onChanged,
  onFailed,
}: {
  plugin: InstalledPluginView;
  onChanged: () => void;
  onFailed: (message: string) => void;
}): JSX.Element {
  const [removing, setRemoving] = useState(false);
  const [purge, setPurge] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const act = (work: Promise<unknown>): void => {
    setBusy(true);
    work
      .then(() => {
        setRemoving(false);
        setPurge(false);
        setConfirm('');
        onChanged();
      })
      .catch((error: unknown) => onFailed(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const c = plugin.contribution;
  return (
    <Stack gap="sm">
      <Card
        tone={plugin.loaded ? undefined : 'critical'}
        title={`${plugin.name} ${plugin.version}`}
        meta={plugin.loaded ? <Pill tone="good">loaded</Pill> : <Pill tone="critical">did not load</Pill>}
        actions={
          <Toolbar align="end">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(!removing)}>
              Remove…
            </Button>
            <Button size="sm" disabled={busy} onClick={() => act(api.updatePlugin(plugin.name))}>
              Update
            </Button>
          </Toolbar>
        }
      >
        <Stack gap="sm">
          {plugin.error ? <Notice tone="critical">{plugin.error}</Notice> : null}
          <KV
            items={[
              { label: 'From', value: sourceWords(plugin.source) },
              { label: 'Published by', value: plugin.publisher ?? 'nobody npm will name' },
              { label: 'Installed', value: fmtRelative(plugin.installedAt) },
              {
                label: 'Contributes',
                value: `${c.tools} tool${c.tools === 1 ? '' : 's'}, ${c.sentinels} on a timer, ${c.views} view${
                  c.views === 1 ? '' : 's'
                }, ${c.agents} agent${c.agents === 1 ? '' : 's'} proposed`,
              },
            ]}
          />
          <Unlocks unlocks={plugin.unlocks} />
        </Stack>
      </Card>
      {removing ? (
        <Stack gap="sm">
          <Notice tone="warning">
            Removing it stops its code loading and leaves its tables exactly where they are, so
            installing it again picks up where it left off.
          </Notice>
          <label className="plugin-check">
            <input type="checkbox" checked={purge} onChange={(event) => { setPurge(event.target.checked); setConfirm(''); }} />
            <span>Also drop its data. Its tables are not recoverable afterwards.</span>
          </label>
          {purge ? (
            <Field label={`Type ${plugin.name} to confirm`}>
              <input value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </Field>
          ) : null}
          <Toolbar align="end">
            <Button variant="ghost" disabled={busy} onClick={() => { setRemoving(false); setPurge(false); setConfirm(''); }}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={busy || (purge && confirm.trim() !== plugin.name)}
              onClick={() =>
                act(api.uninstallPlugin(plugin.name, purge ? { purge: true, confirm: confirm.trim() } : {}))
              }
            >
              {purge ? 'Remove and drop its data' : 'Remove'}
            </Button>
          </Toolbar>
        </Stack>
      ) : null}
    </Stack>
  );
}
