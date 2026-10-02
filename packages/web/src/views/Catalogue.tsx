/**
 * The agent catalogue: teammates someone tested against the plugins they use,
 * picked rather than invented (agent-catalogue.md §6).
 *
 * One page (`#/agents/catalogue`) with a search and the six categories, and a
 * page per package (`#/agents/catalogue/<name>`). Add opens the install sheet,
 * Update the update sheet (`parts/CatalogueSheets`). Home's "Your team", the
 * first-run handover and Browse's Agents filter reuse the card, the face and
 * the sheets from here.
 *
 * What leaves this computer: opening the page asks the gateway for the list,
 * and the gateway fetches it from withbuddi.com when its copy is a day old.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, AGENTS_CHANGED, type CatalogueAgent, type CatalogueView, type CataloguePluginAgent } from '../api';
import type { ChatAgent } from '../chat/types';
import { leaveDraft } from '../chat/draft';
import { AGENTS_ROUTE, agentRoute, catalogueAddRequested, catalogueRoute, chatRoute } from '../routes';
import { ROLE_MAKER } from '../shell/roster';
import { Avatar, Breadcrumb, Button, Card, Code, Details, Empty, ErrorBanner, FilterChips, Icon, Notice, Page, PageHeader, Panel, Pill, SearchField, Spacer, useAsync } from '../ui';
import { useAcceptPluginAgent } from './parts/AgentOffer';
import { pluginTitle as pagesTitle, type PluginPages } from '../pages/usePages';
import { CatFace } from './parts/CatFace';
import { InstallSheet, UpdateSheet } from './parts/CatalogueSheets';
import {
  and,
  categoryWord,
  missingFix,
  missingTitle,
  needWords,
  pluginTitle,
  reachRows,
  shortVersion,
  skillTitle,
  tierMap,
  usesWords,
} from './parts/catalogue-words';

/* ------------------------------------------------------------------ *
 * Where a card stands
 * ------------------------------------------------------------------ */

/**
 * The card's state: `ready` (Add), `added`, `update` (an untouched file with a
 * newer version listed), `edited` (the owner changed the file and a newer one
 * is out: See what changed), `replaced` (an older agent this package does the
 * job of, changed by the owner, so it is left alone), `unavailable`.
 */
export type CardState = 'ready' | 'added' | 'update' | 'edited' | 'replaced' | 'unavailable';

export function cardState(entry: CatalogueAgent): CardState {
  if (entry.state === 'unavailable') return 'unavailable';
  const installed = entry.installed;
  if (entry.state !== 'installed' || !installed) return 'ready';
  if (installed.via && (installed.drift === 'edited' || installed.drift === 'edited-update')) return 'replaced';
  if (installed.drift === 'update') return 'update';
  if (installed.drift === 'edited-update') return 'edited';
  return 'added';
}

/** The plugins this installation has loaded, for "Uses Calendar". Local: nothing leaves. */
export function useLoadedPlugins(): Set<string> {
  const plugins = useAsync(() => api.plugins(), []);
  return useMemo(
    () => new Set((plugins.data?.installed ?? []).filter((p) => p.loaded && p.enabled !== false).map((p) => p.name)),
    [plugins.data],
  );
}

/* ------------------------------------------------------------------ *
 * Pieces the placements share
 * ------------------------------------------------------------------ */

export { CatFace };

function CheckGlyph(): JSX.Element {
  return <Icon name="check" size={14} />;
}

/** Under a card: what is missing as one warning chip ("Needs Finance"), else what it uses, in muted words. */
export function CatChips({ entry, loaded, mailbox }: { entry: CatalogueAgent; loaded: ReadonlySet<string>; mailbox?: boolean | undefined }): JSX.Element | null {
  const state = cardState(entry);
  if (state === 'unavailable') return <span className="cat-chips"><span className="cat-chip" data-need="true">Needs a newer buddi</span></span>;
  const missing = entry.missing ?? [];
  if (missing.length > 0) {
    return (
      <span className="cat-chips">
        <span className="cat-chip" data-need="true">Needs {and(missing.map(missingTitle))}</span>
      </span>
    );
  }
  if (state !== 'ready') return null;
  const uses = usesWords(entry, loaded, mailbox);
  if (uses.length === 0) return null;
  const words = `Uses ${and(uses)}`;
  return <span className="cat-uses" title={words}>{words}</span>;
}

/** The action on the right of a card: Add, Added, Update, or See what changed. */
export function CatAction({ entry, onAdd, onUpdate }: { entry: CatalogueAgent; onAdd: () => void; onUpdate: () => void }): JSX.Element | null {
  const state = cardState(entry);
  const stop = (fn: () => void) => (e: { stopPropagation: () => void }): void => { e.stopPropagation(); fn(); };
  if (state === 'added' || state === 'replaced') return <span className="cat-added"><CheckGlyph />Added</span>;
  if (state === 'update') return <Button size="sm" onClick={stop(onUpdate)} aria-label={`Update ${entry.title}`}>Update</Button>;
  if (state === 'edited') return <Button size="sm" onClick={stop(onUpdate)}>See what changed</Button>;
  if (state === 'unavailable') return null;
  return <Button size="sm" variant="accent" onClick={stop(onAdd)} aria-label={`Add ${entry.title}`}>Add</Button>;
}

function CatNote({ entry }: { entry: CatalogueAgent }): JSX.Element | null {
  const state = cardState(entry);
  const latest = shortVersion(entry.version);
  if (state === 'update') return <p className="cat-note">{latest} is out: {entry.changes.charAt(0).toLowerCase() + entry.changes.slice(1)}</p>;
  if (state === 'edited') return <p className="cat-note">You’ve changed {entry.title}; {latest} is out.</p>;
  if (state === 'replaced') return <p className="cat-note" data-quiet="true">You have @{entry.installed?.handle}, which does this.</p>;
  if (state === 'added') return <p className="cat-note" data-quiet="true">On your team as @{entry.installed?.handle}</p>;
  if (state === 'unavailable') return <p className="cat-note" data-quiet="true">{entry.reason}</p>;
  return null;
}

/** A catalogue card: face, title and category, the pitch, chips and the action on the right. */
export function CatCard({
  entry,
  loaded,
  mailbox,
  onOpen,
  onAdd,
  onUpdate,
}: {
  entry: CatalogueAgent;
  loaded: ReadonlySet<string>;
  /** A mailbox is connected: a card that reads mail says "Uses your mailbox". */
  mailbox?: boolean | undefined;
  onOpen: () => void;
  onAdd: () => void;
  onUpdate: () => void;
}): JSX.Element {
  return (
    <div className="cat-card" data-state={cardState(entry)} data-testid={`cat-card-${entry.name}`}>
      <Card onClick={onOpen} label={`${entry.title}: details`}>
        <div className="cat-card-head">
          <CatFace entry={entry} size="lg" />
          <div className="cat-card-name">
            <h3 className="ui-card-title">{entry.title}</h3>
            <div className="cat-card-kind">{categoryWord(entry.category)}</div>
          </div>
        </div>
        <p className="cat-pitch">{entry.pitch}</p>
        <CatNote entry={entry} />
        <div className="cat-card-foot">
          <CatChips entry={entry} loaded={loaded} mailbox={mailbox} />
          <Spacer />
          <CatAction entry={entry} onAdd={onAdd} onUpdate={onUpdate} />
        </div>
      </Card>
    </div>
  );
}

/** A plugin's own agent ("From Mail"), added through the plugin's accept as before. */
function PluginAgentCard({ row, navigate, pages }: { row: CataloguePluginAgent; navigate: (route: string) => void; pages?: PluginPages | undefined }): JSX.Element {
  const offer = useAcceptPluginAgent(row.plugin, row.agent, () => window.dispatchEvent(new Event(AGENTS_CHANGED)));
  const added = offer.created ?? (row.state === 'installed' ? { id: row.agent, handle: row.handle, name: row.name } : null);
  // Named by its page when it has one ("Mail"), as Home names a plugin.
  const from = pages ? pagesTitle(row.plugin, pages.all) : pluginTitle(row.plugin);
  return (
    <div className="cat-card" data-state={added ? 'added' : 'ready'} data-testid={`cat-card-${row.agent}`}>
      <Card onClick={added ? () => navigate(agentRoute(added.id)) : undefined} label={added ? `Open @${added.handle}` : undefined}>
        <div className="cat-card-head">
          <span className="cat-face" data-size="lg"><Avatar id={row.agent} name={row.name} size="lg" /></span>
          <div className="cat-card-name">
            <h3 className="ui-card-title">{row.name}</h3>
            <div className="cat-card-kind">From {from}</div>
          </div>
        </div>
        <p className="cat-pitch">{row.text}</p>
        {added ? <p className="cat-note" data-quiet="true">On your team as @{added.handle}</p> : null}
        <div className="cat-card-foot">
          <ErrorBanner message={offer.failure} />
          <Spacer />
          {added ? (
            <span className="cat-added"><CheckGlyph />Added</span>
          ) : (
            <Button size="sm" variant="accent" disabled={offer.busy} onClick={(e) => { e.stopPropagation(); offer.accept(); }} aria-label={`Add ${row.name}`}>Add</Button>
          )}
        </div>
      </Card>
    </div>
  );
}

/** Quiet placeholder cards while the list is fetched. */
function CatSkeleton({ n = 6 }: { n?: number }): JSX.Element {
  return (
    <div className="cat-grid" aria-busy="true" aria-label="Loading the catalogue" data-testid="cat-loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="ui-card cat-skel">
          <div className="cat-card-head">
            <i className="cat-skel-face" />
            <span className="cat-card-name"><i className="cat-skel-line" data-w="40" /><i className="cat-skel-line" data-w="20" /></span>
          </div>
          <i className="cat-skel-line" data-w="90" />
          <i className="cat-skel-line" data-w="70" />
        </div>
      ))}
    </div>
  );
}

/** Which sheet is open over a page, for which package. */
export type CatSheet = { kind: 'install' | 'update'; name: string } | null;

/** Open a chat with the maker, the owner's words left in its composer. */
export function askAgentFather(agents: readonly ChatAgent[], navigate: (route: string) => void, words: string): void {
  const maker = agents.find((a) => a.roles.includes(ROLE_MAKER));
  if (!maker) return;
  if (words.trim()) leaveDraft(maker.id, `I'd like a teammate for this: ${words.trim()}`);
  navigate(chatRoute(maker.id));
}

/** The open sheet over a catalogue page, given the list it opened from. */
export function CatalogueSheet({
  sheet,
  view,
  navigate,
  onClose,
  onChanged,
}: {
  sheet: CatSheet;
  view: CatalogueView | undefined;
  navigate: (route: string) => void;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element | null {
  const entry = sheet ? view?.agents.find((a) => a.name === sheet.name) : undefined;
  if (!sheet || !entry) return null;
  if (sheet.kind === 'update' && entry.installed) {
    return <UpdateSheet entry={entry} agentId={entry.installed.agentId} onClose={onClose} onUpdated={onChanged} />;
  }
  return <InstallSheet entry={entry} navigate={navigate} onClose={onClose} onAdded={onChanged} />;
}

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

type Chip = 'all' | 'work' | 'money' | 'home' | 'health' | 'learning' | 'life';
const CHIPS: ReadonlyArray<{ value: Chip; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'work', label: 'Work' },
  { value: 'money', label: 'Money' },
  { value: 'home', label: 'Home' },
  { value: 'health', label: 'Health' },
  { value: 'learning', label: 'Learning' },
  { value: 'life', label: 'Life' },
];

function matches(entry: CatalogueAgent, q: string): boolean {
  return [entry.title, entry.pitch, entry.about, entry.description, categoryWord(entry.category)].some((t) => t.toLowerCase().includes(q));
}

export function Catalogue({
  name,
  agents,
  navigate,
  pluginPages,
}: {
  /** The package whose page is open (`#/agents/catalogue/<name>`), if any. */
  name?: string | undefined;
  agents: readonly ChatAgent[];
  navigate: (route: string) => void;
  /** The plugins' pages, for naming a plugin's own agent by its page ("From Mail"). */
  pluginPages?: PluginPages | undefined;
}): JSX.Element {
  const [refresh, setRefresh] = useState(0);
  const read = useAsync(() => api.catalogue(refresh > 0), [refresh]);
  const loaded = useLoadedPlugins();
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [sheet, setSheet] = useState<CatSheet>(null);
  const view = read.data;
  const changed = (): void => {
    read.reload();
    window.dispatchEvent(new Event(AGENTS_CHANGED));
  };
  const retry = (): void => setRefresh((n) => n + 1);
  const sheets = <CatalogueSheet sheet={sheet} view={view} navigate={navigate} onClose={() => setSheet(null)} onChanged={changed} />;

  const detail = name ? view?.agents.find((a) => a.name === name) : undefined;
  // `?add=1` (the front desk's "Add Chef", Telegram's link): the install sheet opens once, over the detail page.
  const addAsked = useRef(false);
  useEffect(() => {
    if (addAsked.current || !detail || !catalogueAddRequested(window.location.hash, detail.name)) return;
    addAsked.current = true;
    if (cardState(detail) === 'ready') setSheet({ kind: 'install', name: detail.name });
  }, [detail]);
  if (name && view && !view.unavailable) {
    if (detail) {
      return (
        <>
          <AgentDetail
            entry={detail}
            loaded={loaded}
            agents={agents}
            navigate={navigate}
            onAdd={() => setSheet({ kind: 'install', name: detail.name })}
            onUpdate={() => setSheet({ kind: 'update', name: detail.name })}
          />
          {sheets}
        </>
      );
    }
  }

  const q = query.trim().toLowerCase();
  const list = view?.agents ?? [];
  const shown = list.filter((a) => (chip === 'all' || a.category === chip) && (!q || matches(a, q)));
  const fromPlugins = (view?.fromPlugins ?? []).filter((p) => chip === 'all' && (!q || [p.name, p.text, p.description].some((t) => t.toLowerCase().includes(q))));
  const go = (route: string) => (): void => navigate(route);
  return (
    <Page>
      <PageHeader
        before={<Breadcrumb inline items={[{ label: 'Agents', href: AGENTS_ROUTE, onClick: go(AGENTS_ROUTE) }]} />}
        title="Add a teammate"
        lede="Agents tested with the plugins they use. Adding one is one approval, and it becomes a file on this computer you can change."
      />
      {name && view && !view.unavailable && !detail ? (
        <Notice tone="warning">The catalogue lists no teammate called “{name}”. Here is everyone it does list.</Notice>
      ) : null}
      <div className="cat-bar">
        <div className="cat-search">
          <Icon name="search" size={16} />
          <SearchField label="Search teammates" value={query} placeholder="Search: meals, money, a language…" onChange={setQuery} />
        </div>
        <div className="cat-cats">
          <FilterChips<Chip> label="Category" options={CHIPS} value={chip} onChange={setChip} />
        </div>
      </div>
      {view && !view.unavailable ? (
        view.stale ? (
          <p className="plugins-quiet" data-testid="cat-stale">
            <Icon name="globe" size={14} />
            From the list kept {view.fetchedAt ? fmtAgo(view.fetchedAt) : 'earlier'}: withbuddi.com didn’t answer just now.{' '}
            <button type="button" className="plugins-link" onClick={retry}>Try again</button>
          </p>
        ) : (
          <p className="plugins-quiet">
            <Icon name="globe" size={14} />
            Opening this page fetched the list from withbuddi.com. Nothing else leaves.
          </p>
        )
      ) : null}
      {read.error && !view ? (
        <Empty warm title="The catalogue didn’t load" action={<Button variant="accent" size="sm" onClick={retry}>Try again</Button>}>{read.error}</Empty>
      ) : !view ? (
        <CatSkeleton />
      ) : view.unavailable ? (
        <Empty warm title="The catalogue needs withbuddi.com" action={<Button variant="accent" size="sm" disabled={read.loading} onClick={retry}>Try again</Button>}>
          This computer can’t reach it right now, and there’s no saved copy yet. Try again when you’re online.
        </Empty>
      ) : shown.length + fromPlugins.length > 0 ? (
        <div className="cat-grid" data-testid="cat-grid">
          {shown.map((a) => (
            <CatCard
              key={a.name}
              entry={a}
              loaded={loaded}
              mailbox={view.mailbox}
              onOpen={() => navigate(catalogueRoute(a.name))}
              onAdd={() => setSheet({ kind: 'install', name: a.name })}
              onUpdate={() => setSheet({ kind: 'update', name: a.name })}
            />
          ))}
          {fromPlugins.map((p) => <PluginAgentCard key={`${p.plugin}/${p.agent}`} row={p} navigate={navigate} pages={pluginPages} />)}
        </div>
      ) : (
        <Empty
          warm
          title="No teammate for that yet"
          action={
            <span className="cat-empty-acts">
              <Button size="sm" variant="ghost" onClick={() => { setQuery(''); setChip('all'); }}>Show all</Button>
              <Button size="sm" variant="accent" onClick={() => askAgentFather(agents, navigate, query)}>Ask Agent Father</Button>
            </span>
          }
        >
          {q ? <>Nothing in the catalogue does “{query.trim()}”. Agent Father can make one for you; your words go with you.</> : 'Nothing in this category yet.'}
        </Empty>
      )}
      {view && !view.unavailable && view.delisted.length > 0 ? (
        <Panel title="No longer in the catalogue">
          <ul className="cat-plugins" data-testid="cat-delisted">
            {view.delisted.map((d) => (
              <li key={d.agentId}>
                <Avatar id={d.agentId} name={d.name ?? d.handle} size="sm" />
                <span className="cat-plugin-text">
                  <a className="cat-plugin-name" href={agentRoute(d.agentId)} onClick={(e) => { e.preventDefault(); navigate(agentRoute(d.agentId)); }}>{d.name ?? `@${d.handle}`}</a>
                  <span className="cat-small">@{d.handle} keeps working as it is; no updates will come.</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {sheets}
    </Page>
  );
}

function fmtAgo(iso: string): string {
  const hours = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  if (!Number.isFinite(hours) || hours < 1) return 'an hour ago';
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/* ------------------------------------------------------------------ *
 * The detail page
 * ------------------------------------------------------------------ */

function CatRow({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="cat-row">
      <h2 className="cat-row-title">{title}</h2>
      <div className="cat-row-body">{children}</div>
    </section>
  );
}

/** Plugins and needs, each with its state or its one fix. */
function PluginRows({ entry, loaded, navigate }: { entry: CatalogueAgent; loaded: ReadonlySet<string>; navigate: (route: string) => void }): JSX.Element {
  const missing = new Map((entry.missing ?? []).map((m) => [m.name, m]));
  const rows = [
    ...Object.keys(entry.requires).map((name) => ({ name, needed: true, need: false })),
    ...Object.keys(entry.optional).map((name) => ({ name, needed: false, need: false })),
    ...entry.needs.map((n) => ({ name: n.replace(/\?$/, ''), needed: !n.endsWith('?'), need: true })),
  ];
  if (rows.length === 0) return <p className="cat-small">None. It works with what buddi has.</p>;
  return (
    <ul className="cat-plugins">
      {rows.map(({ name, needed, need }) => {
        const gap = missing.get(name);
        const fix = gap ? missingFix(gap) : null;
        const title = need ? needWords(name).title : gap?.kind === 'plugin' ? gap.title : pluginTitle(name);
        const have = need ? needed && !gap : loaded.has(name);
        return (
          <li key={`${need ? 'need' : 'plugin'}-${name}`}>
            <span className="ui-app-icon" aria-hidden="true"><Icon name={need ? (name === 'mailbox' ? 'mail' : 'key') : 'plug'} size={14} /></span>
            <span className="cat-plugin-text">
              <span className="cat-plugin-name">{title.charAt(0).toUpperCase() + title.slice(1)}</span>
              <span className="cat-small">{needed ? 'Needed' : 'Better with it'}</span>
            </span>
            {fix ? (
              <Button size="sm" onClick={() => navigate(fix.route)}>{fix.label}</Button>
            ) : gap ? (
              <span className="cat-small">Installed when you add it</span>
            ) : have ? (
              <span className="cat-added"><CheckGlyph />{need ? 'You have one' : 'Installed'}</span>
            ) : (
              <span className="cat-small">{need ? 'Optional' : 'Not installed'}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function AgentDetail({
  entry,
  loaded,
  agents,
  navigate,
  onAdd,
  onUpdate,
}: {
  entry: CatalogueAgent;
  loaded: ReadonlySet<string>;
  agents: readonly ChatAgent[];
  navigate: (route: string) => void;
  onAdd: () => void;
  onUpdate: () => void;
}): JSX.Element {
  const state = cardState(entry);
  const agentId = entry.installed?.agentId;
  const added = agentId;
  const latest = shortVersion(entry.version);
  const openChat = (text?: string): void => {
    if (!added) return;
    if (text) leaveDraft(added, text);
    navigate(chatRoute(added));
  };
  const reach = reachRows(entry.tools, tierMap(entry.claims?.tools));
  const replaces = entry.replaces.map((r) => skillTitle(r.split('/')[1] ?? r));
  return (
    <Page>
      <a className="cat-back" href={catalogueRoute()} onClick={(e) => { e.preventDefault(); navigate(catalogueRoute()); }}>
        <Icon name="chevron-left" size={12} />Teammates
      </a>
      <header className="cat-hero">
        <CatFace entry={entry} size="xxl" />
        <div className="cat-hero-text">
          <h1 className="cat-hero-title">{entry.title}</h1>
          <p className="cat-hero-pitch">{entry.pitch}</p>
          <p className="cat-hero-meta">
            {entry.trust === 'by-buddi' ? <Pill tone="accent">by buddi</Pill> : null}
            <span>{categoryWord(entry.category)}</span>
            <span aria-hidden="true">·</span>
            <span className="mono">{entry.installed?.version ?? entry.version}</span>
            {entry.installed ? (
              <>
                <span aria-hidden="true">·</span>
                <span>on your team as <span className="mono">@{entry.installed.handle}</span></span>
              </>
            ) : null}
          </p>
        </div>
        <div className="cat-hero-act">
          {state === 'ready' ? (
            <Button variant="accent" onClick={onAdd}>Add {entry.title}</Button>
          ) : state === 'update' ? (
            <>
              <Button variant="ghost" onClick={() => openChat()}>Open chat</Button>
              <Button variant="accent" onClick={onUpdate}>Update to {latest}</Button>
            </>
          ) : state === 'edited' ? (
            <>
              <Button variant="ghost" onClick={() => openChat()}>Open chat</Button>
              <Button onClick={onUpdate}>See what changed</Button>
            </>
          ) : state === 'unavailable' ? null : (
            <Button variant="accent" onClick={() => openChat()}>Open chat</Button>
          )}
        </div>
      </header>
      {state === 'edited' ? (
        <Notice tone="accent">You’ve changed {entry.title} since you added it, so {latest} isn’t applied on its own. Your file stays as it is unless you replace it.</Notice>
      ) : state === 'unavailable' ? (
        <Notice tone="warning">{entry.reason}</Notice>
      ) : null}
      <Panel flush>
        <div className="cat-rows">
          <CatRow title="What it does">
            <p className="cat-prose">{entry.about}</p>
            {replaces.length > 0 ? (
              <p className="cat-small">Does what {and(replaces)} did. If you have {and(replaces)} and haven’t changed it, it’s offered as an update.</p>
            ) : null}
          </CatRow>
          {entry.examples.length > 0 ? (
            <CatRow title="Ask it">
              <div className="wb-starters">
                {entry.examples.map((s) => (
                  <button key={s} type="button" className="wb-starter" disabled={!added} onClick={() => openChat(s)}>{s}</button>
                ))}
              </div>
              {added ? null : <p className="cat-small">Once it’s on your team, a tap opens a chat with it.</p>}
            </CatRow>
          ) : null}
          <CatRow title="Skills">
            {entry.skills.length === 0 ? (
              <p className="cat-small">None. It works from its persona.</p>
            ) : (
              <>
                <ul className="cat-plugins" data-testid="cat-skills">
                  {entry.skills.map((skill) => (
                    <li key={skill.name}>
                      <span className="ui-app-icon" aria-hidden="true"><Icon name="files" size={14} /></span>
                      <span className="cat-plugin-text">
                        <span className="cat-plugin-name">{skillTitle(skill.name)}</span>
                        {skill.description ? <span className="cat-small">{skill.description}</span> : null}
                        <Details summary="Read it">
                          <Code label={`${skillTitle(skill.name)}: the skill's text`}>{skill.text}</Code>
                        </Details>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="cat-small">
                  Plain text, no code.{' '}
                  {added ? (
                    <>Read and change them on <a href={agentRoute(added, 'skills')} onClick={(e) => { e.preventDefault(); navigate(agentRoute(added, 'skills')); }}>its Skills tab</a>.</>
                  ) : (
                    'Once it’s on your team they’re files you can read and change.'
                  )}
                </p>
              </>
            )}
          </CatRow>
          <CatRow title="What it can reach">
            <dl className="cat-reach">
              {reach.map(([k, v]) => (
                <div key={k} className="cat-reach-row"><dt>{k}</dt><dd>{v}</dd></div>
              ))}
            </dl>
            <p className="cat-small">Anything that sends or pays still asks you first, every time. You can change any of this on its page.</p>
          </CatRow>
          <CatRow title="Missions">
            {entry.missions.length > 0 ? (
              <ul className="cat-missions">
                {entry.missions.map((m) => (
                  <li key={m.id}>
                    <span className="cat-mission-name">{m.name}</span>
                    <span className="cat-mission-when">{m.when}</span>
                    <span className="cat-off">off until you turn it on</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cat-small">None. It works when you ask.</p>
            )}
          </CatRow>
          <CatRow title="Plugins">
            <PluginRows entry={entry} loaded={loaded} navigate={navigate} />
          </CatRow>
          <CatRow title="Version">
            <p className="cat-prose"><span className="mono">{entry.version}</span> · {entry.changes}</p>
            <p className="cat-small">Reviewed in withbuddi/buddi-market. An update always asks you, and never touches a file you changed.</p>
          </CatRow>
        </div>
      </Panel>
    </Page>
  );
}
