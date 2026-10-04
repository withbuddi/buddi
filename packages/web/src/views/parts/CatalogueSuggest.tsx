/**
 * Teammates suggested from what the owner set up (agent-catalogue.md §6):
 * three or four catalogue packages on the first-run handover ("Who do you
 * want on your team?") and on Home while the team is new.
 *
 * The rule, from chapters 3 and 4: a mailbox or My days → Chief of Staff;
 * Finance → CFO; Pictures → Illustrator; filled up with Researcher, then
 * Tutor. Only packages the catalogue lists, that are not on the team yet, and
 * that Add can bring in now are suggested.
 */
import { useEffect, useMemo, useState } from 'react';
import { api, AGENTS_CHANGED, ApiError, type CatalogueAgent, type CatalogueJob } from '../../api';
import type { ChatAgent } from '../../chat/types';
import { catalogueRoute } from '../../routes';
import { ROLE_MAKER } from '../../shell/roster';
import { FRONT_DESK_ROLE } from '../../shell/roles';
import { Button, Icon, Notice, Spacer, Toolbar } from '../../ui';
import { cardState, useLoadedPlugins } from '../Catalogue';
import { CatFace } from './CatFace';
import { InstallSheet, JOB_POLL_MS } from './CatalogueSheets';
import { and, missingFix, missingTitle } from './catalogue-words';

export interface SetUp {
  days?: boolean;
  mailbox?: boolean;
  money?: boolean;
  pictures?: boolean;
}

/** The suggestion rule, as package names in order; at most four. */
export function suggestNames({ days, mailbox, money, pictures }: SetUp): string[] {
  const names: string[] = [];
  if (mailbox || days) names.push('chief-of-staff');
  if (money) names.push('cfo');
  if (pictures) names.push('illustrator');
  for (const filler of ['researcher', 'tutor']) if (names.length < 3) names.push(filler);
  return names.slice(0, 4);
}

/** The rule applied to the list: listed, not on the team, addable now. Fillers stand in for one that is not. */
export function suggestFrom(agents: readonly CatalogueAgent[], setUp: SetUp, max = 4): CatalogueAgent[] {
  const ok = (a: CatalogueAgent | undefined): a is CatalogueAgent => !!a && cardState(a) === 'ready' && a.addable;
  const picked = suggestNames(setUp).map((n) => agents.find((a) => a.name === n)).filter(ok);
  for (const filler of ['researcher', 'tutor']) {
    if (picked.length >= 3) break;
    const a = agents.find((x) => x.name === filler);
    if (ok(a) && !picked.includes(a)) picked.push(a);
  }
  return picked.slice(0, max);
}

/** A handover suggestion: why it is offered, and — when it cannot be added yet — its one missing step. */
export interface Suggestion {
  entry: CatalogueAgent;
  /** "because you set up My days"; "popular" for a filler. */
  reason: string;
  /** Not addable yet: the step, in words that follow "ready once you", and where it is taken. */
  blocked?: { step: string; fix: { label: string; route: string } | null };
}

const FILLERS = ['researcher', 'tutor'];

/** Why the rule picked a package, from what was set up. */
function reasonFor(name: string, setUp: SetUp): string {
  if (name === 'chief-of-staff') return setUp.days ? 'because you set up My days' : 'because you added a mailbox';
  if (name === 'cfo') return 'because you set up My money';
  if (name === 'illustrator') return 'because you set up Pictures';
  return 'popular';
}

/**
 * The handover's suggestions: the rule's picks with their reasons, a pick that
 * is one step from ready shown with that step rather than dropped, and fillers
 * ("popular") until three are on show. At most four.
 */
export function suggestWithReasons(agents: readonly CatalogueAgent[], setUp: SetUp, max = 4): Suggestion[] {
  const out: Suggestion[] = [];
  for (const name of suggestNames(setUp).filter((n) => !FILLERS.includes(n))) {
    const entry = agents.find((a) => a.name === name);
    // Not listed, on the team already, or never addable here: nothing to offer.
    if (!entry || cardState(entry) !== 'ready') continue;
    if (entry.addable) {
      out.push({ entry, reason: reasonFor(name, setUp) });
      continue;
    }
    const missing = entry.missing ?? [];
    const first = missing.find((m) => missingFix(m) !== null) ?? missing[0];
    if (!first) continue;
    const fix = missingFix(first);
    const step = fix ? fix.label.charAt(0).toLowerCase() + fix.label.slice(1) : `${missingTitle(first)} is here`;
    out.push({ entry, reason: reasonFor(name, setUp), blocked: { step, fix } });
  }
  for (const name of FILLERS) {
    if (out.length >= 3) break;
    const entry = agents.find((a) => a.name === name);
    if (entry && cardState(entry) === 'ready' && entry.addable) out.push({ entry, reason: 'popular' });
  }
  return out.slice(0, max);
}

/**
 * Whether the team is still new: the front desk and the maker plus at most
 * one more. Home shows suggestions then, and the Add a teammate tile after.
 */
export function teamIsNew(agents: readonly ChatAgent[], defaultAgentId: string | null | undefined): boolean {
  const others = agents.filter((a) => a.id !== defaultAgentId && !a.roles.includes(FRONT_DESK_ROLE) && !a.roles.includes(ROLE_MAKER));
  return agents.length > 0 && others.length <= 1;
}

/** Add one package with its defaults and wait for the job to end. */
export async function addAndWait(entry: CatalogueAgent, pollMs = JOB_POLL_MS): Promise<CatalogueJob | { error: string }> {
  try {
    // The card's grant, as the package declares it: the click approves that, or the job asks.
    const { jobId } = await api.catalogueInstall(entry.name, { version: entry.version, tools: entry.tools });
    for (;;) {
      const job = await api.catalogueJob(jobId);
      if (job.state !== 'running') return job;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (err) {
    return { error: err instanceof ApiError ? err.message : String(err) };
  }
}

/** A suggestion row with a tick: the face, the title, why it is offered, and the pitch. */
export function CatPick({ entry, checked, onChange, reason }: { entry: CatalogueAgent; checked: boolean; onChange: (checked: boolean) => void; reason?: string }): JSX.Element {
  return (
    <label className="cat-pick" data-checked={checked ? 'true' : undefined} data-testid={`cat-pick-${entry.name}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <CatFace entry={entry} size="lg" />
      <span className="cat-pick-text">
        <span className="cat-pick-name">
          {entry.title}
          {reason ? <span className="cat-pick-why">{reason}</span> : null}
        </span>
        <span className="cat-pick-pitch">{entry.pitch}</span>
      </span>
    </label>
  );
}

/**
 * A pick that is one step from ready: greyed, no tick, the step in its name
 * line ("ready once you add a mailbox") and a way to take it.
 */
export function CatPickBlocked({ suggestion, onFix }: { suggestion: Suggestion; onFix: (route: string) => void }): JSX.Element {
  const { entry, reason, blocked } = suggestion;
  return (
    <div className="cat-pick" data-blocked="true" data-testid={`cat-pick-${entry.name}`}>
      <input type="checkbox" checked={false} disabled aria-label={`${entry.title}: not ready yet`} onChange={() => {}} />
      <CatFace entry={entry} size="lg" />
      <span className="cat-pick-text">
        <span className="cat-pick-name">
          {entry.title} · ready once you {blocked?.step}
          <span className="cat-pick-why">{reason}</span>
        </span>
        <span className="cat-pick-pitch">{entry.pitch}</span>
      </span>
      {blocked?.fix ? (
        <Button size="sm" onClick={() => onFix(blocked.fix!.route)}>
          {blocked.fix.label}
        </Button>
      ) : null}
    </div>
  );
}

/** A suggestion as a compact card (Home): face, title, pitch, Add on the right. */
export function CatSuggest({ entry, added, onOpen, onAdd }: { entry: CatalogueAgent; added: boolean; onOpen: () => void; onAdd: () => void }): JSX.Element {
  return (
    <div
      className="cat-suggest"
      role="button"
      tabIndex={0}
      aria-label={`${entry.title}: details`}
      data-testid={`cat-suggest-${entry.name}`}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === 'Enter') onOpen(); }}
    >
      <CatFace entry={entry} size="lg" />
      <span className="cat-pick-text">
        <span className="cat-pick-name">{entry.title}</span>
        <span className="cat-pick-pitch">{entry.pitch}</span>
      </span>
      {added ? (
        <span className="cat-added"><Icon name="check" size={14} />Added</span>
      ) : (
        <Button size="sm" variant="accent" aria-label={`Add ${entry.title}`} onClick={(e) => { e.stopPropagation(); onAdd(); }}>Add</Button>
      )}
    </div>
  );
}

/**
 * Home's suggestions while the team is new: three cards, each with Add (the
 * install sheet opens here). Nothing when the catalogue cannot be read.
 */
export function HomeSuggestions({ navigate }: { navigate: (route: string) => void }): JSX.Element | null {
  const [listed, setListed] = useState<CatalogueAgent[] | null>(null);
  const [adding, setAdding] = useState<CatalogueAgent | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const loaded = useLoadedPlugins();
  useEffect(() => {
    let cancelled = false;
    api
      .catalogue()
      .then((v) => { if (!cancelled) setListed(v.unavailable ? [] : v.agents); })
      .catch(() => { if (!cancelled) setListed([]); });
    return () => {
      cancelled = true;
    };
  }, []);
  // What was set up, as this installation shows it: a day's plugins and a mailbox are the default
  // reading; Finance and Image count once they are loaded.
  const view = useMemo(
    () => (listed === null ? null : suggestFrom(listed, { days: true, mailbox: true, money: loaded.has('finance'), pictures: loaded.has('image') }, 3)),
    [listed, loaded],
  );
  if (!view || view.length === 0) return null;
  return (
    <>
      <p className="cat-suggest-lede">Teammates who could take a job off your hands, from what you set up:</p>
      <div className="cat-suggests" data-testid="home-suggestions">
        {view.map((entry) => (
          <CatSuggest
            key={entry.name}
            entry={entry}
            added={added.includes(entry.name)}
            onOpen={() => navigate(catalogueRoute(entry.name))}
            onAdd={() => setAdding(entry)}
          />
        ))}
      </div>
      {adding ? (
        <InstallSheet
          entry={adding}
          navigate={navigate}
          onClose={() => setAdding(null)}
          onAdded={() => {
            setAdded((list) => [...list, adding.name]);
            window.dispatchEvent(new Event(AGENTS_CHANGED));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The first-run handover's card: "Who do you want on your team?", the
 * suggestions ticked, Add these adds the ticked ones in one go (their plugins
 * are already in), See all teammates opens the catalogue.
 */
export function HandoverTeam({ setUp, navigate }: { setUp: SetUp; navigate: (route: string) => void }): JSX.Element | null {
  const [offered, setOffered] = useState<Suggestion[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [phase, setPhase] = useState<'picking' | 'adding' | 'added'>('picking');
  const [joined, setJoined] = useState<CatalogueAgent[]>([]);
  const [failed, setFailed] = useState<Array<{ entry: CatalogueAgent; error: string }>>([]);
  const key = JSON.stringify(setUp);
  useEffect(() => {
    let cancelled = false;
    api
      .catalogue()
      .then((v) => {
        if (cancelled) return;
        const list = v.unavailable ? [] : suggestWithReasons(v.agents, setUp);
        setOffered(list);
        setTicked(list.filter((s) => !s.blocked).map((s) => s.entry.name));
      })
      .catch(() => { if (!cancelled) setOffered([]); });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!offered || offered.length === 0) return null;
  // Only the ones Add can bring in now are ticked and counted; a blocked pick shows its step instead.
  const suggested = offered.filter((s) => !s.blocked).map((s) => s.entry);
  const fromSetUp = offered.some((s) => !s.blocked && s.reason !== 'popular');
  const seeAll = (): void => navigate(catalogueRoute());
  const add = async (): Promise<void> => {
    setPhase('adding');
    const ok: CatalogueAgent[] = [];
    const bad: Array<{ entry: CatalogueAgent; error: string }> = [];
    for (const entry of suggested.filter((a) => ticked.includes(a.name))) {
      const job = await addAndWait(entry);
      if ('error' in job && !('state' in job)) bad.push({ entry, error: job.error });
      else if ((job as CatalogueJob).state === 'done') ok.push(entry);
      else if ((job as CatalogueJob).state === 'confirm') bad.push({ entry, error: 'it gets more than its card showed, so it waits for your approval in Needs you' });
      else bad.push({ entry, error: (job as CatalogueJob).error ?? 'it stopped before it finished' });
    }
    setJoined(ok);
    setFailed(bad);
    setPhase('added');
    if (ok.length > 0) window.dispatchEvent(new Event(AGENTS_CHANGED));
  };
  const count = ticked.length;
  const label =
    phase === 'adding'
      ? `Adding ${count === 1 ? suggested.find((a) => a.name === ticked[0])?.title ?? '1' : count}…`
      : count > 0 && count === suggested.length
        ? 'Add these'
        : count > 0
          ? `Add these ${count}`
          : 'Tick one to add';
  return (
    <section className="handover-team" aria-label="Who do you want on your team?" data-testid="handover-team">
      {phase === 'added' ? (
        <>
          {joined.length > 0 ? (
            <Notice
              tone="good"
              role="status"
              title={`${and(joined.map((a) => a.title))} ${joined.length === 1 ? 'is' : 'are'} on your team.`}
              action={<Button variant="ghost" size="sm" onClick={seeAll}>See all teammates</Button>}
            >
              Say hello in Chat. {joined.length === 1 ? 'Its missions are' : 'Their missions are'} off until you turn them on.
            </Notice>
          ) : null}
          {failed.length > 0 ? (
            <Notice
              tone="critical"
              role="alert"
              title={`${and(failed.map((f) => f.entry.title))} ${failed.length === 1 ? 'wasn’t' : 'weren’t'} added.`}
              action={joined.length === 0 ? <Button variant="ghost" size="sm" onClick={seeAll}>See all teammates</Button> : undefined}
            >
              {failed.map((f) => `${f.entry.title}: ${f.error.replace(/[.\s]+$/, '')}.`).join(' ')} Nothing else changed; try again from the catalogue.
            </Notice>
          ) : null}
        </>
      ) : (
        <>
          <div className="handover-team-head">
            <h2 className="handover-team-title">Who do you want on your team?</h2>
            <p className="cat-small">
              {fromSetUp
                ? 'Picked from what you just set up. Their plugins are already in, so one click adds them all.'
                : 'A few teammates people often start with. One click adds the ones you tick.'}
            </p>
          </div>
          <div className="cat-picks">
            {offered.map((s) =>
              s.blocked ? (
                <CatPickBlocked key={s.entry.name} suggestion={s} onFix={navigate} />
              ) : (
                <CatPick
                  key={s.entry.name}
                  entry={s.entry}
                  reason={s.reason}
                  checked={ticked.includes(s.entry.name)}
                  onChange={(v) => setTicked(v ? [...ticked, s.entry.name] : ticked.filter((x) => x !== s.entry.name))}
                />
              ),
            )}
          </div>
          <div className="handover-team-foot">
            <Toolbar>
              <Button variant="ghost" onClick={seeAll}>See all teammates</Button>
              <Spacer />
              <Button variant="accent" disabled={count === 0 || phase === 'adding' || suggested.length === 0} onClick={() => void add()}>{label}</Button>
            </Toolbar>
          </div>
        </>
      )}
    </section>
  );
}
