/**
 * The catalogue's two sheets (agent-catalogue.md §6, §8).
 *
 * **Install**: what adding the package does, read from the gateway's plan —
 * the By-buddi plugins installed on the way, a few picks filled in for the
 * owner, the handle, the missions with their switches (off), and the reach in
 * one line with See all. "Add <name>" is the one approval. Then the job's
 * progress in place, polled; then "<name> is on your team", or the failure in
 * words with Try again. When the job waits on an approval the sheet says so
 * and points at Needs you.
 *
 * **Update**: an untouched file gets the changes line, the persona diff and the
 * reach and missions in a sentence each, Not now / Update. A file the owner
 * changed is never touched on its own: Keep mine / Replace my changes, the
 * diff behind See what changed.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  type CatalogueAgent,
  type CatalogueJob,
  type CataloguePlan,
  type CatalogueUpdatePlan,
  type MarketEntryView,
} from '../../api';
import { leaveDraft } from '../../chat/draft';
import { catalogueRoute, chatRoute, NEEDS_ROUTE, settingsRoute } from '../../routes';
import { AppIcon, Button, Empty, ErrorBanner, Field, Icon, Notice, Pill, Sheet, Spacer, Stack, Switch, Toolbar } from '../../ui';
import { useMediaQuery } from '../../useMediaQuery';
import { CatFace } from './CatFace';
import { and, missingFix, missingTitle, reachLine, reachRows, shortVersion, tierMap } from './catalogue-words';

/** How often the sheet asks how the install is going. */
export const JOB_POLL_MS = 800;

/** A listing's summary, to its first full stop. */
const firstSentence = (text: string): string => /^.*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text.trim();

const errorText = (err: unknown): string => (err instanceof ApiError ? err.message : String(err));

function SheetTitle({ entry, children }: { entry: CatalogueAgent; children: ReactNode }): JSX.Element {
  return (
    <span className="plugins-sheet-title">
      <CatFace entry={entry} size="lg" />
      <span className="plugins-sheet-name">
        <span>{children}</span>
        <span className="plugins-sheet-by">
          by {entry.author.name}
          {entry.trust === 'by-buddi' ? <> · <Pill tone="accent">by buddi</Pill></> : null}
        </span>
      </span>
    </span>
  );
}

type StepView = 'done' | 'now' | 'next' | 'failed';

function Step({ state, children }: { state: StepView; children: ReactNode }): JSX.Element {
  return (
    <li className="cat-step" data-state={state}>
      <span className="cat-step-mark">
        {state === 'done' ? <Icon name="check" size={12} /> : state === 'failed' ? <Icon name="alert" size={14} /> : null}
      </span>
      <span>{children}</span>
    </li>
  );
}

/** One job step in words: "Installing Finance…", "Installed Finance", "Adding CFO". */
function stepWords(step: CatalogueJob['steps'][number]): { state: StepView; words: string } {
  const verb = step.kind === 'plugin' ? ['Installing', 'Installed'] : ['Adding', 'Added'];
  if (step.state === 'done') return { state: 'done', words: `${verb[1]} ${step.title}` };
  if (step.state === 'failed') {
    return { state: 'failed', words: step.kind === 'plugin' ? `${step.title} didn’t install` : `${step.title} wasn’t added` };
  }
  if (step.state === 'waiting') return { state: 'next', words: `${verb[0]} ${step.title}` };
  return { state: 'now', words: `${verb[0]} ${step.title}…` };
}

/** Follow one install job until it ends. */
function useJob(id: string | null): { job: CatalogueJob | null; error: string | null; setJob: (job: CatalogueJob) => void } {
  const [job, setJob] = useState<CatalogueJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setJob(null);
    setError(null);
    if (!id) return undefined;
    let stopped = false;
    let timer: number | undefined;
    const ask = (): void => {
      api
        .catalogueJob(id)
        .then((next) => {
          if (stopped) return;
          setJob(next);
          if (next.state === 'running') timer = window.setTimeout(ask, JOB_POLL_MS);
        })
        .catch((err: unknown) => {
          if (!stopped) setError(errorText(err));
        });
    };
    ask();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id]);
  return { job, error, setJob };
}

/* ------------------------------------------------------------------ *
 * Install
 * ------------------------------------------------------------------ */

export function InstallSheet({
  entry,
  navigate,
  onClose,
  onAdded,
}: {
  entry: CatalogueAgent;
  navigate: (route: string) => void;
  onClose: () => void;
  onAdded?: (agent: { id: string; handle: string }) => void;
}): JSX.Element {
  const phone = useMediaQuery('(max-width: 720px)');
  const [plan, setPlan] = useState<CataloguePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [fills, setFills] = useState<Record<string, string>>({});
  const [handle, setHandle] = useState('');
  const [on, setOn] = useState<string[]>([]);
  const [allReach, setAllReach] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const { job, error: jobError, setJob } = useJob(jobId);
  const [answering, setAnswering] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [allConfirmReach, setAllConfirmReach] = useState(false);
  const told = useRef(false);
  /** The plugins it installs on the way, as withbuddi.com lists them: their icon and their one line. */
  const [listings, setListings] = useState<MarketEntryView[]>([]);
  useEffect(() => {
    if (!plan || plan.plugins.length === 0) return undefined;
    let cancelled = false;
    Promise.resolve().then(() => api.market()).then((m) => { if (!cancelled) setListings(m?.plugins ?? []); }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [plan]);

  useEffect(() => {
    let cancelled = false;
    api
      .cataloguePlan(entry.name)
      .then((answer) => {
        if (cancelled) return;
        setPlan(answer);
        setFills(Object.fromEntries(answer.fills.map((f) => [f.id, f.value])));
        setHandle(answer.handle);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPlanError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.name]);

  useEffect(() => {
    if (job?.state === 'done' && job.agent && !told.current) {
      told.current = true;
      onAdded?.(job.agent);
    }
  }, [job, onAdded]);

  const start = (): void => {
    if (!plan) return;
    setStarting(true);
    setStartError(null);
    told.current = false;
    api
      // The grant the sheet lists: the click approves it only if that is what resolves.
      .catalogueInstall(entry.name, { version: plan.version, fills, handle, missionsOn: on, tools: plan.tools.map((t) => t.name) })
      .then((answer) => setJobId(answer.jobId))
      .catch((err: unknown) => setStartError(errorText(err)))
      .finally(() => setStarting(false));
  };
  const retry = (): void => {
    setJobId(null);
    start();
  };

  const title = entry.title;
  const agent = job?.agent;
  const sayHello = (text?: string): void => {
    if (!agent) return;
    if (text) leaveDraft(agent.id, text);
    onClose();
    navigate(chatRoute(agent.id));
  };

  const answer = (approve: boolean): void => {
    if (!job) return;
    setAnswering(true);
    setConfirmError(null);
    api
      .catalogueConfirm(job.id, approve)
      .then((next) => {
        setJob(next);
        if (!approve) onClose();
      })
      .catch((err: unknown) => setConfirmError(errorText(err)))
      .finally(() => setAnswering(false));
  };

  /* ---- the grant that resolved is not the one shown ---- */
  if (job?.state === 'confirm' && job.confirm) {
    const confirmRows = reachRows(job.confirm.tools.map((t) => t.name), tierMap(job.confirm.tools));
    const installed = job.steps.filter((s) => s.kind === 'plugin' && s.state === 'done').map((s) => s.title);
    return (
      <Sheet
        title={<SheetTitle entry={entry}>Add {title}</SheetTitle>}
        onClose={onClose}
        foot={
          <Toolbar>
            <Spacer />
            <Button variant="ghost" disabled={answering} onClick={() => answer(false)}>Don’t add it</Button>
            <Button variant="accent" disabled={answering} onClick={() => answer(true)}>Add {title}</Button>
          </Toolbar>
        }
      >
        <ol className="cat-steps" data-testid="cat-confirm">
          {job.steps.filter((s) => s.kind === 'plugin').map((step) => {
            const { state, words } = stepWords(step);
            return <Step key={`${step.kind}-${step.name}`} state={state}>{words}</Step>;
          })}
        </ol>
        <Notice tone="warning" title={`${title} would get more than the list showed.`}>
          {installed.length > 0 ? `With ${and(installed)} installed, ` : ''}its tools resolved to a different set
          {job.confirm.unshown.length > 0 ? `, including ${and(job.confirm.unshown)}` : ''}. Look at what it can reach before you add it.
        </Notice>
        <ErrorBanner message={confirmError} />
        <div className="cat-block">
          <h3 className="cat-block-title">What it can reach</h3>
          <p className="cat-prose">
            {reachLine(confirmRows)}{' '}
            <button type="button" className="plugins-link cat-link" onClick={() => setAllConfirmReach(!allConfirmReach)}>{allConfirmReach ? 'Hide' : 'See all'}</button>
          </p>
          {allConfirmReach ? (
            <dl className="cat-reach">
              {confirmRows.map(([k, v]) => <div key={k} className="cat-reach-row"><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
          ) : null}
        </div>
        <p className="cat-small">The plugins stay installed either way; Settings → Plugins removes them.</p>
      </Sheet>
    );
  }

  /* ---- progress ---- */
  if (jobId && (!job || job.state === 'running')) {
    const agentStep = job?.steps[job.steps.length - 1];
    const waitingOnApproval = job?.approvalId && agentStep?.state === 'adding';
    return (
      <Sheet
        title={<SheetTitle entry={entry}>Add {title}</SheetTitle>}
        onClose={onClose}
        foot={<Toolbar align="end"><Button onClick={onClose}>Close</Button></Toolbar>}
      >
        <ol className="cat-steps" aria-live="polite" data-testid="cat-progress">
          {(job?.steps ?? []).map((step) => {
            const { state, words } = stepWords(step);
            return <Step key={`${step.kind}-${step.name}`} state={state}>{words}</Step>;
          })}
        </ol>
        {waitingOnApproval ? (
          <Notice tone="accent" action={<Button size="sm" onClick={() => { onClose(); navigate(NEEDS_ROUTE); }}>Open it</Button>}>
            Adding {title} waits for your approval in Needs you.
          </Notice>
        ) : null}
        <ErrorBanner message={jobError} />
        <p className="cat-small">You can close this; it carries on, and {title} joins the team when it’s done.</p>
      </Sheet>
    );
  }

  /* ---- done ---- */
  if (job?.state === 'done') {
    const installed = job.steps.filter((s) => s.kind === 'plugin').map((s) => s.title);
    const missions = plan?.missions.length ?? entry.missions.length;
    const missionsOn = on.length;
    return (
      <Sheet
        title={<SheetTitle entry={entry}>{title}</SheetTitle>}
        onClose={onClose}
        foot={
          <Toolbar>
            <Button variant="ghost" onClick={() => { onClose(); navigate(catalogueRoute()); }}>Back to teammates</Button>
            <Spacer />
            <Button variant="accent" onClick={() => sayHello()}>Say hello</Button>
          </Toolbar>
        }
      >
        <div className="cat-done" data-testid="cat-done">
          <CatFace entry={entry} size="xxl" />
          <p className="cat-done-title">{title} is on your team.</p>
          <p className="cat-small">
            @{agent?.handle ?? handle}
            {installed.length ? ` · ${and(installed)} installed` : ''}
            {missions > 0 && missionsOn < missions ? ` · ${missions - missionsOn === 1 ? 'a mission' : 'missions'} off until you turn ${missions - missionsOn === 1 ? 'it' : 'them'} on` : ''}
          </p>
        </div>
        {entry.examples.length > 0 ? (
          <div className="cat-block">
            <h3 className="cat-block-title">Try one</h3>
            <div className="wb-starters">
              {entry.examples.map((s) => (
                <button key={s} type="button" className="wb-starter" onClick={() => sayHello(s)}>{s}</button>
              ))}
            </div>
          </div>
        ) : null}
      </Sheet>
    );
  }

  /* ---- failure ---- */
  if (job?.state === 'failed') {
    const failedPlugin = job.steps.find((s) => s.kind === 'plugin' && s.state === 'failed');
    return (
      <Sheet
        title={<SheetTitle entry={entry}>{title} wasn’t added</SheetTitle>}
        onClose={onClose}
        foot={
          <Toolbar>
            <Spacer />
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="accent" disabled={starting} onClick={retry}>Try again</Button>
          </Toolbar>
        }
      >
        <ol className="cat-steps" data-testid="cat-failed">
          {job.steps.map((step) => {
            const { state, words } = stepWords(step);
            return <Step key={`${step.kind}-${step.name}`} state={state === 'now' ? 'next' : state}>{state === 'now' ? words.replace(/…$/, '') : words}</Step>;
          })}
        </ol>
        <Notice
          tone="critical"
          title={`${job.error ?? 'It stopped before it finished'}.`}
          action={job.approvalId ? <Button size="sm" onClick={() => { onClose(); navigate(NEEDS_ROUTE); }}>Open the approval</Button> : undefined}
        >
          <p>
            Nothing was added and nothing else changed.
            {failedPlugin ? (
              <>
                {' '}{failedPlugin.title} waits in{' '}
                <a href={settingsRoute('plugins')} onClick={(e) => { e.preventDefault(); onClose(); navigate(settingsRoute('plugins')); }}>Settings → Plugins</a>{' '}
                if you’d rather look at it there.
              </>
            ) : null}
          </p>
        </Notice>
        <ErrorBanner message={startError} />
      </Sheet>
    );
  }

  /* ---- confirm ---- */
  const plugins = plan?.plugins.filter((p) => p.fix === 'install' && p.byBuddi) ?? [];
  const blocked = plan?.blocked ?? [];
  const firstBlock = blocked[0];
  const blockFix = firstBlock ? missingFix(firstBlock) : null;
  // The names are the plan's (the package's own list while a plugin is missing); the listing's claims only lend their tiers' words.
  const rows = reachRows(plan ? plan.tools.map((t) => t.name) : entry.tools, tierMap([...(entry.claims?.tools ?? []), ...(plan?.tools ?? []).filter((t) => t.tier !== 'unknown')]));
  const whenOf = (id: string): string => entry.missions.find((m) => m.id === id)?.when ?? '';
  return (
    <Sheet
      title={<SheetTitle entry={entry}>Add {title}</SheetTitle>}
      onClose={onClose}
      foot={
        <Toolbar>
          {phone ? null : (
            <span className="plugins-foot-note">
              {plugins.length ? `Installs ${and(plugins.map((p) => p.title))}, then adds ${title}.` : 'Nothing runs until you add it.'}
            </span>
          )}
          <Spacer />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!plan || blocked.length > 0 || starting || handle.length < 2} onClick={start}>Add {title}</Button>
        </Toolbar>
      }
    >
      <p className="cat-lede">{entry.pitch} One approval adds it; you can change or remove it from its page.</p>
      <ErrorBanner message={planError ?? startError} />
      {!plan && !planError ? (
        <Empty>Reading what it needs…</Empty>
      ) : plan ? (
        <Stack divided gap="lg">
          {plugins.length > 0 ? (
            <div className="cat-block">
              <h3 className="cat-block-title">Installed on the way</h3>
              <ul className="cat-plugins">
                {plugins.map((p) => {
                  const listing = listings.find((l) => l.name === p.name);
                  return (
                  <li key={p.name}>
                    <AppIcon svg={listing?.iconSvg} />
                    <span className="cat-plugin-text">
                      <span className="cat-plugin-name">{p.title} {p.version ? <span className="plugins-ver">{p.version}</span> : null}</span>
                      <span className="cat-small">{listing?.summary ? firstSentence(listing.summary) : 'Made by buddi; installed only if it matches what withbuddi.com lists.'}</span>
                    </span>
                    <Pill tone="accent">by buddi</Pill>
                  </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {firstBlock ? (
            <Notice
              tone="warning"
              action={blockFix ? <Button size="sm" onClick={() => { onClose(); navigate(blockFix.route); }}>{blockFix.label}</Button> : undefined}
            >
              {title} needs {and(blocked.map(missingTitle))} first. Add {blocked.length === 1 ? 'it' : 'them'}, then come back; nothing is added until then.
            </Notice>
          ) : null}
          {plan.fills.length > 0 ? (
            <div className="cat-block">
              <h3 className="cat-block-title">A few picks <span className="cat-block-aside">filled in for you</span></h3>
              <div className="cat-fills">
                {plan.fills.map((f) => (
                  <Field key={f.id} label={<>{f.label}{f.optional ? <span className="faint"> · optional</span> : null}</>}>
                    {f.choices && f.choices.length > 0 ? (
                      <select value={fills[f.id] ?? ''} onChange={(e) => setFills({ ...fills, [f.id]: e.target.value })}>
                        {f.kind === 'calendar' ? <option value="">All of them</option> : null}
                        {f.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : f.kind === 'time' ? (
                      <input type="time" value={fills[f.id] ?? ''} onChange={(e) => setFills({ ...fills, [f.id]: e.target.value })} />
                    ) : (
                      <input value={fills[f.id] ?? ''} onChange={(e) => setFills({ ...fills, [f.id]: e.target.value })} />
                    )}
                  </Field>
                ))}
              </div>
            </div>
          ) : null}
          <div className="cat-block">
            <Field label="Handle" hint="How you call it in chat and on Telegram.">
              <span className="cat-handle">
                <span className="mono faint">@</span>
                <input className="mono" aria-label="Handle" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
              </span>
            </Field>
          </div>
          {plan.missions.length > 0 ? (
            <div className="cat-block">
              <h3 className="cat-block-title">Missions <span className="cat-block-aside">off unless you turn one on</span></h3>
              <ul className="cat-missions" data-switches="true">
                {plan.missions.map((m) => (
                  <li key={m.id}>
                    <span className="cat-mission-name">{m.name}</span>
                    <span className="cat-mission-when">{whenOf(m.id)}</span>
                    <Switch checked={on.includes(m.id)} label={`Turn on ${m.name}`} onChange={(v) => setOn(v ? [...on, m.id] : on.filter((x) => x !== m.id))} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="cat-block">
            <h3 className="cat-block-title">What it can reach</h3>
            <p className="cat-prose">
              {reachLine(rows)}{' '}
              <button type="button" className="plugins-link cat-link" onClick={() => setAllReach(!allReach)}>{allReach ? 'Hide' : 'See all'}</button>
            </p>
            {allReach ? (
              <dl className="cat-reach">
                {rows.map(([k, v]) => <div key={k} className="cat-reach-row"><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
            ) : null}
          </div>
        </Stack>
      ) : null}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * Update
 * ------------------------------------------------------------------ */

type DiffRow = { kind: 'add' | 'del' | 'ctx'; text: string; n: number | null } | { kind: 'gap'; count: number };

/**
 * The gateway's unified diff (`@@ -a,b +c,d @@` hunks, `- `/`+ `/`  ` lines) as rows: each line with its
 * number in the new file (none for a removed line), and a gap row for the unchanged lines between hunks.
 */
export function diffRows(lines: readonly string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let next: number | null = null;
  let shownTo = 0;
  for (const line of lines) {
    const header = /^@@ -\d+,\d+ \+(\d+),(\d+) @@$/.exec(line);
    if (header) {
      const start = Number(header[2]) === 0 ? Number(header[1]) + 1 : Number(header[1]);
      if (rows.length > 0 && start - 1 > shownTo) rows.push({ kind: 'gap', count: start - 1 - shownTo });
      next = start;
      continue;
    }
    const kind = line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : 'ctx';
    const text = kind === 'ctx' && !line.startsWith('  ') ? line : line.slice(2);
    if (kind === 'del' || next === null) {
      rows.push({ kind, text, n: null });
    } else {
      rows.push({ kind, text, n: next });
      shownTo = next;
      next += 1;
    }
  }
  return rows;
}

function Diff({ lines, label }: { lines: readonly string[]; label: string }): JSX.Element {
  return (
    <div className="cat-diff" role="region" aria-label={label}>
      {diffRows(lines).map((row, i) =>
        row.kind === 'gap' ? (
          <div key={i} className="cat-diff-line" data-kind="gap">
            <span className="cat-diff-n" aria-hidden="true" />
            <span className="cat-diff-k" aria-hidden="true" />
            <span>⋯ {row.count} {row.count === 1 ? 'line' : 'lines'}</span>
          </div>
        ) : (
          <div key={i} className="cat-diff-line" data-kind={row.kind}>
            <span className="cat-diff-n" aria-hidden="true">{row.n ?? ''}</span>
            <span className="cat-diff-k" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
            <span>{row.text || ' '}</span>
          </div>
        ),
      )}
    </div>
  );
}

export function UpdateSheet({
  entry,
  agentId,
  onClose,
  onUpdated,
}: {
  entry: CatalogueAgent;
  agentId: string;
  onClose: () => void;
  onUpdated?: () => void;
}): JSX.Element {
  const [plan, setPlan] = useState<CatalogueUpdatePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api
      .catalogueUpdatePlan(entry.name, agentId)
      .then((answer) => { if (!cancelled) setPlan(answer); })
      .catch((err: unknown) => { if (!cancelled) setError(errorText(err)); });
    return () => {
      cancelled = true;
    };
  }, [entry.name, agentId]);
  const latest = shortVersion(plan?.version ?? entry.version);
  const run = (replace: boolean): void => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    api
      .catalogueUpdate(entry.name, agentId, plan.plan, replace)
      .then(() => {
        setDone(true);
        onUpdated?.();
      })
      .catch((err: unknown) => {
        setError(errorText(err));
        // Something moved since this sheet was read (a new version, a file on disk): show what is true now.
        api.catalogueUpdatePlan(entry.name, agentId).then(setPlan).catch(() => {});
      })
      .finally(() => setBusy(false));
  };

  if (done) {
    return (
      <Sheet
        title={<SheetTitle entry={entry}>{entry.title} {latest}</SheetTitle>}
        onClose={onClose}
        foot={<Toolbar align="end"><Button variant="accent" onClick={onClose}>Done</Button></Toolbar>}
      >
        <Notice tone="good" title={`${entry.title} is on ${latest}.`} role="status">
          {plan?.edited ? 'Your version is in the trash folder if you want any of it back.' : 'Your picks and missions are as they were.'}
        </Notice>
      </Sheet>
    );
  }

  if (!plan) {
    return (
      <Sheet title={<SheetTitle entry={entry}>Update {entry.title}</SheetTitle>} onClose={onClose}>
        <ErrorBanner message={error} />
        {error ? null : <Empty>Reading what changed…</Empty>}
      </Sheet>
    );
  }

  const added = plan.personaDiff.filter((l) => l.startsWith('+ ')).length;
  const removed = plan.personaDiff.filter((l) => l.startsWith('- ')).length;

  if (plan.edited) {
    return (
      <Sheet
        title={<SheetTitle entry={entry}>{entry.title} {latest} is out</SheetTitle>}
        onClose={onClose}
        foot={
          <Toolbar>
            {diff ? null : <Button variant="ghost" onClick={() => setDiff(true)}>See what changed</Button>}
            <Spacer />
            <Button variant="ghost" onClick={onClose}>Keep mine</Button>
            <Button variant="danger" disabled={busy} onClick={() => run(true)}>Replace my changes</Button>
          </Toolbar>
        }
      >
        <Notice tone="accent">
          {plan.replacesOwn && plan.replacesOwn.length > 0
            ? `${latest} brings ${plan.replacesOwn.length === 1 ? 'a skill' : 'skills'} named like your own (${and(plan.replacesOwn)}), so nothing is updated on its own. Yours stay exactly as they are unless you replace them; replaced, they go to the trash folder.`
            : plan.via
              ? `${entry.title} replaces your @${plan.handle}. You’ve changed @${plan.handle}, so nothing is replaced on its own. Your file stays exactly as it is unless you replace it; its handle, chats, memory and missions stay either way.`
              : `You’ve changed ${entry.title} since you added it, so nothing is updated on its own. Your file stays exactly as it is unless you replace it.`}
        </Notice>
        <ErrorBanner message={error} />
        <Stack divided gap="lg">
          <div className="cat-block">
            <h3 className="cat-block-title">New in {latest}</h3>
            <p className="cat-prose">{plan.changes}</p>
          </div>
          <div className="cat-block">
            <h3 className="cat-block-title">
              Your file and {latest}{' '}
              <button type="button" className="cat-block-aside plugins-link" onClick={() => setDiff(!diff)}>{diff ? 'Hide' : 'See what changed'}</button>
            </h3>
            {diff ? (
              <>
                <Diff lines={plan.personaDiff} label={`Your ${entry.title} against ${latest}`} />
                <p className="cat-small">Lines marked − are in your file and not in {latest}; + is new in {latest}. Replacing keeps your picks, and drops what you wrote by hand.</p>
              </>
            ) : (
              <p className="cat-small">{removed === 1 ? '1 line' : `${removed} lines`} only in your file, {added === 1 ? '1 line' : `${added} lines`} new in {latest}.</p>
            )}
          </div>
        </Stack>
      </Sheet>
    );
  }

  const reachWords = plan.added.length > 0
    ? `New: ${and(reachRows(plan.added.map((t) => t.name), tierMap(plan.added)).map(([k]) => k))}. The approval lists each tool.`
    : 'No new tools. It reaches what it reaches today.';
  return (
    <Sheet
      title={<SheetTitle entry={entry}>Update {entry.title} to {latest}</SheetTitle>}
      onClose={onClose}
      foot={
        <Toolbar>
          <span className="plugins-foot-note">Your picks and handle stay.</span>
          <Spacer />
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button variant="accent" disabled={busy} onClick={() => run(false)}>Update {entry.title}</Button>
        </Toolbar>
      }
    >
      <p className="cat-lede">{plan.changes}</p>
      <ErrorBanner message={error} />
      <Stack divided gap="lg">
        <div className="cat-block">
          <h3 className="cat-block-title">What changes in its file</h3>
          {plan.personaDiff.length > 0 ? (
            <Diff lines={plan.personaDiff} label={plan.via ? `@${plan.handle} against ${entry.title} ${latest}` : `${entry.title} ${shortVersion(plan.fromVersion)} against ${latest}`} />
          ) : (
            <p className="cat-prose">Its persona stays word for word.</p>
          )}
        </div>
        <div className="cat-block">
          <h3 className="cat-block-title">What it can reach</h3>
          <p className="cat-prose">{reachWords}{plan.removed.length > 0 ? ` No longer: ${plan.removed.join(', ')}.` : ''}</p>
        </div>
        <div className="cat-block">
          <h3 className="cat-block-title">Missions</h3>
          <p className="cat-prose">
            {plan.missionsAdded.length > 0
              ? `${and(plan.missionsAdded.map((m) => m.name))} added, off until you turn ${plan.missionsAdded.length === 1 ? 'it' : 'them'} on. Yours stay as they are.`
              : 'None added. Yours stay as they are.'}
          </p>
        </div>
        {plan.retires && plan.retires.length > 0 ? (
          <div className="cat-block">
            <h3 className="cat-block-title">Skills</h3>
            <p className="cat-prose">{latest} no longer has {and(plan.retires)}; {plan.retires.length === 1 ? 'it goes' : 'they go'} to the trash folder.</p>
          </div>
        ) : null}
      </Stack>
    </Sheet>
  );
}
