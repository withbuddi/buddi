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
import { useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  type ApprovalRow,
  type BuiltInPluginView,
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
  Spacer,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';
import { ApprovalCard, useDecide } from './parts/ApprovalCard';

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

/** Where a plugin comes from. Three ways in, and they ask for different things. */
type InstallMode = 'npm' | 'file' | 'directory';

const MODES: Array<{ id: InstallMode; label: string }> = [
  { id: 'npm', label: 'From npm' },
  { id: 'file', label: 'A file' },
  { id: 'directory', label: 'A directory I built' },
];

/** The last way in, so the developer path is not retyped every visit. */
const MODE_KEY = 'buddi.plugins.install-mode';

function rememberedMode(): InstallMode {
  try {
    const saved = window.localStorage.getItem(MODE_KEY);
    if (MODES.some((mode) => mode.id === saved)) return saved as InstallMode;
  } catch {
    // Storage the browser refuses is not worth an error on this page.
  }
  return 'npm';
}

function rememberMode(mode: InstallMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Same: the choice just does not survive the visit.
  }
}

/** The one thing a file has to be. */
const PLUGIN_SUFFIX = '.tgz';

/** What a plugin contributes, counted in words, leaving out what it has none of. */
function contributionWords(c: { tools: number; sentinels: number; views: number; agents: number }): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(c.tools, 'tool', 'tools');
  add(c.sentinels, 'watcher', 'watchers');
  add(c.views, 'view', 'views');
  add(c.agents, 'agent', 'agents');
  return parts.length === 0 ? 'nothing on its own' : parts.join(', ');
}

/** A source, in one readable phrase. */
function sourceWords(source: PluginSource): string {
  if (source.kind === 'registry') return `npm · ${source.name}@${source.version}`;
  if (source.kind === 'tarball') return `a file on this machine · ${source.path}`;
  return `a directory on this machine · ${source.path}`;
}

/**
 * Who put this code here.
 *
 * Only the registry has a publisher to name. Code that came off this machine
 * was put there by the owner, and saying "nobody npm will name" about it reads
 * as a warning about something that is simply not npm's to vouch for.
 */
function publisherWords(source: PluginSource, publisher: string | null | undefined): string {
  if (source.kind === 'directory') return 'you, from this machine';
  if (source.kind === 'tarball') return 'a file on this machine';
  return publisher ?? 'nobody npm will name';
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

      {(data?.builtIn ?? []).length > 0 ? (
        <Panel title="Ships with buddi">
          <Stack divided>
            {(data?.builtIn ?? []).map((plugin) => (
              <Section key={plugin.name}>
                <BuiltIn plugin={plugin} />
              </Section>
            ))}
          </Stack>
        </Panel>
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------------ *
 * What was already here
 * ------------------------------------------------------------------ */

/**
 * One plugin buddi ships with.
 *
 * Nothing to approve and nothing to remove, so it is a name, a version and
 * what it contributes: the part of the tool list that came with the box.
 */
function BuiltIn({ plugin }: { plugin: BuiltInPluginView }): JSX.Element {
  return (
    <Stack gap="sm">
      <KV
        items={[
          {
            label: <span>{plugin.name}</span>,
            value: (
              <span>
                {plugin.version} · {contributionWords(plugin.contribution)}
              </span>
            ),
          },
        ]}
      />
      {plugin.description ? <p className="ui-card-meta">{plugin.description}</p> : null}
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
  const [mode, setMode] = useState<InstallMode>(rememberedMode);
  const [spec, setSpec] = useState('');
  const [sending, setSending] = useState(false);
  /** The file the zone is holding, and why it is holding none. */
  const [chosen, setChosen] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);

  const fail = (error: unknown): void =>
    onFailed(error instanceof ApiError ? error.message : String(error));

  const choose = (next: InstallMode): void => {
    setMode(next);
    rememberMode(next);
    setRefused(null);
  };

  const go = (): void => {
    setSending(true);
    api
      .stagePlugin(spec.trim())
      .then((answer) => {
        onStaged(answer.job.id);
        setSpec('');
      })
      .catch(fail)
      .finally(() => setSending(false));
  };

  /*
   * A picked or dropped file is the whole act: there is nothing left to type,
   * so the upload — and with it the read — starts here rather than behind a
   * second click. A file that is not a .tgz never leaves the browser.
   */
  const take = (file: File | undefined): void => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(PLUGIN_SUFFIX)) {
      setChosen(null);
      setRefused(`${file.name} is not a ${PLUGIN_SUFFIX}. A packed plugin is the file npm pack writes.`);
      return;
    }
    setRefused(null);
    setChosen(file.name);
    setSending(true);
    api
      .uploadPlugin(file)
      .then((answer) => onStaged(answer.job.id))
      .catch(fail)
      .finally(() => setSending(false));
  };

  return (
    <Stack gap="sm">
      <div className="plugin-modes" role="radiogroup" aria-label="Where it comes from">
        {MODES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={mode === choice.id}
            className="plugin-mode"
            data-chosen={mode === choice.id ? 'true' : undefined}
            onClick={() => choose(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>

      {mode === 'file' ? (
        <div
          className="plugin-drop"
          role="group"
          aria-label="A plugin file"
          data-state={over ? 'over' : refused ? 'refused' : chosen ? 'chosen' : undefined}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            take(event.dataTransfer?.files?.[0]);
          }}
        >
          <p className="ui-card-meta">
            {refused ?? (chosen ? `${chosen} — reading it.` : `Drop a ${PLUGIN_SUFFIX} here, or choose one.`)}
          </p>
          <Toolbar align="end">
            <Button variant="accent" disabled={busy || sending} onClick={() => picker.current?.click()}>
              Choose a file
            </Button>
          </Toolbar>
          <input
            ref={picker}
            type="file"
            accept={PLUGIN_SUFFIX}
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              take(event.target.files?.[0]);
              // So picking the same file twice still counts as picking it.
              event.target.value = '';
            }}
          />
        </div>
      ) : (
        <>
          <Field
            label={mode === 'npm' ? 'Install a plugin' : 'The directory it is in'}
            hint={
              mode === 'npm'
                ? 'A package name, or a name@version.'
                : 'The folder with its package.json, already built.'
            }
          >
            <input
              type="text"
              value={spec}
              placeholder={mode === 'npm' ? 'buddi-plugin-weather' : '/home/you/code/buddi-plugin-weather'}
              onChange={(event) => setSpec(event.target.value)}
            />
          </Field>
          <Toolbar align="end">
            <Button variant="accent" disabled={busy || sending || spec.trim() === ''} onClick={go}>
              Read it first
            </Button>
          </Toolbar>
        </>
      )}
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
        /*
         * Always sent, empty string included. A directory source has no
         * integrity at all, and dropping the field for it — which is what a
         * falsy check did — made the server answer "send back the integrity
         * you were shown" to a card that was showing none.
         */
        integrity: staged.integrity ?? '',
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
              {
                label: 'From',
                value: staged.uploadedName
                  ? `a file you chose · ${staged.uploadedName}`
                  : sourceWords(staged.source),
              },
              { label: 'Published by', value: staged.publisher ?? 'nobody npm will name' },
              {
                label: 'Integrity',
                value: (
                  <span className="mono">
                    {staged.integrity === undefined || staged.integrity === ''
                      ? 'none — this came off a disk'
                      : staged.integrity}
                  </span>
                ),
              },
              ...(staged.stagedHash
                ? [
                    {
                      label: 'Files on disk',
                      value: <span className="mono">{staged.stagedHash}</span>,
                    },
                  ]
                : []),
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

/**
 * The agents a plugin proposes, and where the owner's copy stands.
 *
 * `plugin` is the installed plugin's name, and it is what makes each row
 * actionable: a staged package proposes agents too, but nothing of it is
 * installed yet, so there those rows are a list and nothing more.
 */
function Unlocks({ plugin, unlocks }: { plugin?: string; unlocks: PluginUnlock[] }): JSX.Element | null {
  if (unlocks.length === 0) return null;
  return (
    <Section title="Agents it would unlock">
      <Stack gap="sm" divided>
        {unlocks.map((unlock) => (
          <Unlock key={unlock.id} plugin={plugin} unlock={unlock} />
        ))}
        {/* Accepting one is an approval with the whole grant in front of you.
            It can happen here now, and it still happens on the Agents page. */}
        <p className="ui-card-meta">
          Nothing here is created by installing. Accepting one shows you the whole tool grant and waits
          for your approval — here, or <a href={AGENTS_ROUTE}>on the Agents page</a>.
        </p>
      </Stack>
    </Section>
  );
}

/** One proposed agent: what it is, and the button that starts the approval. */
function Unlock({ plugin, unlock }: { plugin?: string; unlock: PluginUnlock }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const accepted = unlock.drift.state !== 'not-accepted';
  const accept = (): void => {
    if (!plugin) return;
    setBusy(true);
    setFailure(null);
    api
      .acceptPluginAgent(plugin, unlock.id)
      .then((answer) => setApprovalId(answer.approvalId ?? null))
      .catch((error: unknown) => setFailure(error instanceof ApiError ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return (
    <Stack gap="sm">
      <Toolbar>
        <span className="mono">@{unlock.handle}</span>
        <Pill tone={unlock.drift.state === 'up-to-date' ? 'good' : 'warning'}>{unlock.drift.state}</Pill>
        <span className="ui-card-meta">{unlock.drift.message}</span>
        <Spacer />
        {plugin && !accepted ? (
          <Button size="sm" disabled={busy || approvalId !== null} onClick={accept}>
            Accept
          </Button>
        ) : null}
      </Toolbar>
      <ErrorBanner message={failure} />
      {approvalId ? <Approval id={approvalId} onDecided={() => setApprovalId(null)} /> : null}
    </Stack>
  );
}

/**
 * The approval the Accept button produced, drawn where it was asked for.
 *
 * The very card Home draws, from the same route: a decision made here and a
 * decision made there are the same row, and the same race.
 */
function Approval({ id, onDecided }: { id: string; onDecided: () => void }): JSX.Element {
  const action = useAsync<ApprovalRow>(() => api.approval(id), [id]);
  const { busy, note, failure, decide } = useDecide(() => onDecided());
  if (action.error) return <ErrorBanner message={action.error} />;
  if (!action.data) return <Empty>Loading the approval…</Empty>;
  return (
    <Stack gap="sm">
      <ApprovalCard
        action={action.data}
        timezone={Intl.DateTimeFormat().resolvedOptions().timeZone}
        busy={busy === id}
        onDecide={(actionId, decision, scope, choices) => {
          void decide(actionId, decision, scope, choices);
        }}
      />
      {note ? <Notice tone="good" role="status">{note}</Notice> : null}
      <ErrorBanner message={failure} />
    </Stack>
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
              { label: 'Published by', value: publisherWords(plugin.source, plugin.publisher) },
              { label: 'Installed', value: fmtRelative(plugin.installedAt) },
              {
                label: 'Contributes',
                value: `${c.tools} tool${c.tools === 1 ? '' : 's'}, ${c.sentinels} on a timer, ${c.views} view${
                  c.views === 1 ? '' : 's'
                }, ${c.agents} agent${c.agents === 1 ? '' : 's'} proposed`,
              },
            ]}
          />
          <Unlocks plugin={plugin.name} unlocks={plugin.unlocks} />
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
