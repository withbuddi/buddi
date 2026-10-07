/**
 * The canvas: tabs across the top holding the last few things this
 * conversation produced, one panel below.
 *
 * The tabs exist so that reading an approval does not cost you the chart you
 * were looking at. A tab is known by its tool and its subject — the file, the
 * account, the page — so a second call on the same thing updates the tab it
 * has, with the earlier result a step back inside it (`tab-order.ts`).
 *
 * **The strip is capped at three**, most recently looked at first: opening a
 * fourth moves the oldest into the timeline behind one control, grouped Now /
 * Earlier this turn / Earlier. Two things are never pushed off it: what the
 * owner is looking at, and a decision waiting to be made. A failure can be
 * pushed off, but not silently: the control wears its dot. The same menu
 * closes all tabs, or all but the one in front.
 *
 * Empty, it teaches rather than apologises. The things it names are the view
 * descriptors of the tools this conversation's agent is granted — real titles
 * from real plugins, arriving as data over `GET /api/chat/views` and matched
 * against the agent's resolved grant — so the Illustrator promises a picture
 * and not a balance, and this file still knows the name of no tool at all.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tabs from '@radix-ui/react-tabs';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApprovalRow } from '../api';
import { RenderView } from './registry';
import type { Renderable, RendererName, StructuredProps, ViewDescriptor } from './types';
import { ToolResult } from './views/ToolResult';
import { Profile, type ProfileProps } from './views/Profile';
import { ArtifactView, type ArtifactViewProps } from './views/ArtifactView';
import { DelegateView, type DelegateViewProps } from './views/DelegateView';
import { FilesView, type FilesViewProps } from './views/FilesView';
import { NotifyView, type NotifyViewProps } from './views/NotifyView';
import { SourcesView, sourcesSummary } from './views/SourcesView';
import type { SourcesPanelProps } from './renderables';
import type { ChatAgent } from '../chat/types';
import { Icon } from '../ui/Icon';
import { fmtClock, fmtTime } from '../format';
import { Button } from '../ui';
import { splitTabs, STRIP_TABS, timelineOf, type TimelineGroup } from './tab-order';
import type { TabVersion } from './types';

export { splitTabs } from './tab-order';

/** How many examples the empty state names. Two or three teach; eight lecture. */
const MAX_EXAMPLES = 3;

/**
 * The room one tab takes, measured against the titles these actually get —
 * `Orchard · Forecast`, `Approval` — with the padding and the dot counted in.
 * A title longer than this ellipsises rather than pushing its neighbours off.
 */
const TAB_WIDTH = 152;

/** The room the overflow control takes, reserved whether or not it is shown. */
const OVERFLOW_WIDTH = 104;

/** The strip's own side padding and the Canvas label before the tabs, neither available to tabs. */
const STRIP_PADDING = 28 + 72;

/**
 * Never fewer than two, so a strip still reads as a strip on a phone, and
 * never more than three: a fourth tab is further away than the timeline.
 */
const MIN_TABS = 2;
const MAX_TABS = STRIP_TABS;

export function Canvas({
  renderables,
  activeId,
  onActivate,
  timezone,
  onDecided,
  onChangeAgent,
  face,
  cardFace,
  descriptors,
  grantedTools,
  agentName,
  maxTabs,
  browserPanel,
  browserMenu,
  agents,
  onClose,
  onCloseMany,
  touched,
  turnStartedAt,
  now = Date.now,
  loading = false,
}: {
  renderables: Renderable[];
  activeId: string | null;
  onActivate: (id: string) => void;
  timezone: string;
  onDecided?: (action: ApprovalRow) => void;
  /** Where the properties panel's one button goes: the maker, with a subject. */
  onChangeAgent?: ProfileProps['onChange'];
  /** The face of the agent whose canvas this is, drawn over the empty line. */
  face?: ReactNode;
  /** The same face, small, for the head of a generic tool-result card. */
  cardFace?: ReactNode;
  /** The installed view descriptors, used to say what could appear here. */
  descriptors?: ViewDescriptor[];
  /**
   * The tools of the agent (or the room's members) this canvas belongs to.
   * The empty state promises only what these can draw; without them it
   * promises nothing.
   */
  grantedTools?: readonly string[];
  agentName?: string;
  /** Forces how many tabs fit, for tests: jsdom lays nothing out and measures 0. */
  maxTabs?: number;
  /** Live host state supplied by the page, never by tool-result props. */
  browserPanel?: ReactNode;
  /** The Page tab's overflow (Stop agents' browsing, Show the window, the full page view), at the strip's end while it is in front. */
  browserMenu?: ReactNode;
  /**
   * The roster, for the one panel that draws another agent: a delegation.
   * Supplied by the page — a name and a face are the page's to give, never a
   * tool result's.
   */
  agents?: readonly ChatAgent[];
  onClose?: (id: string) => void;
  /** Close all, Close others: every id the owner put away at once. */
  onCloseMany?: (ids: string[]) => void;
  /** When each tab was last looked at (epoch ms), by id: the strip's order. */
  touched?: Readonly<Record<string, number>>;
  /** When the owner last spoke: the timeline's "this turn" starts there. */
  turnStartedAt?: string | null;
  /** The clock, for tests. */
  now?: () => number;
  /**
   * The conversation is still on its way. The empty canvas stays blank rather
   * than introducing an agent whose tabs may be a moment from arriving.
   */
  loading?: boolean;
}): JSX.Element {
  const [strip, fits] = useTabsThatFit(maxTabs);
  /** The version the owner stepped to, per tab, until a newer one arrives. */
  const [picked, setPicked] = useState<Record<string, string>>({});
  const labels = useMemo(() => labelsOf(renderables, timezone), [renderables, timezone]);
  if (renderables.length === 0) {
    return (
      <div className="wb-canvas" data-testid="canvas">
        <div className="wb-canvas-tabs" ref={strip} aria-hidden="true">
          <span className="wb-canvas-label">Canvas</span>
        </div>
        <div className="wb-canvas-body wb-canvas-body-empty">
          {/* The kit's empty canvas: the agent's face, and one line that
              names what its own tools can put here — nothing it cannot. */}
          {loading ? null : <div className="wb-empty">
            {face ? <span className="wb-empty-face">{face}</span> : null}
            <p className="ui-empty wb-empty-line">{emptyLine(agentName, examplesFor(descriptors ?? [], grantedTools ?? []))}</p>
          </div>}
        </div>
      </div>
    );
  }

  const active = renderables.some((item) => item.id === activeId)
    ? (activeId as string)
    : (renderables[renderables.length - 1]!.id);

  const { shown, hidden } = splitTabs(renderables, active, fits, touched);
  const closeableIds = renderables.filter(closeable).map((item) => item.id);

  return (
    <div className="wb-canvas" data-testid="canvas">
      <Tabs.Root value={active} onValueChange={onActivate} className="contents">
        <div className="wb-canvas-tabs" ref={strip}>
          <span className="wb-canvas-label" aria-hidden="true">Canvas</span>
          <Tabs.List className="wb-tabstrip" aria-label="Canvas">
            {shown.map((item) => (
              <div key={item.id} className="wb-tab-item">
              <Tabs.Trigger value={item.id} className="wb-tab" data-tone={item.tone}
                onKeyDown={event => { if (event.key === 'Delete' && onClose && closeable(item)) { event.preventDefault(); onClose(item.id); } }}>
                {item.tone === 'warning' || item.tone === 'critical' ? (
                  <span className="wb-tab-dot" data-tone={item.tone} aria-hidden="true" />
                ) : null}
                <span className="wb-tab-text">{labels.get(item.id) ?? item.title}</span>
                {item.count ? <span className="wb-tab-count">{item.count}</span> : null}
              </Tabs.Trigger>
              {onClose && closeable(item) ? <button className="wb-tab-close" aria-label={`Close ${labels.get(item.id) ?? item.title} tab`} title="Dismiss panel; keep conversation history" onClick={() => onClose(item.id)}>×</button> : null}
              </div>
            ))}
          </Tabs.List>
          <TabMenu
            items={hidden}
            onActivate={onActivate}
            timezone={timezone}
            labels={labels}
            groups={timelineOf(hidden, { now: now(), turnStartedAt: turnStartedAt ?? null, ...(touched ? { touched } : {}) })}
            {...(onCloseMany ? {
              onCloseAll: closeableIds.length > 0 ? () => onCloseMany(closeableIds) : undefined,
              onCloseOthers: closeableIds.some((id) => id !== active) ? () => onCloseMany(closeableIds.filter((id) => id !== active)) : undefined,
            } : {})}
          />
          {browserMenu && renderables.find((item) => item.id === active)?.source === 'browser' ? <span className="wb-canvas-menu">{browserMenu}</span> : null}
        </div>
        {renderables.map((tab) => {
          const versions = tab.versions ?? [];
          const shownId = picked[`${tab.id}:${versions.length}:${tab.focus ?? ''}`]
            ?? (tab.focus && versions.some((version) => version.id === tab.focus) ? tab.focus : null);
          const version = shownId ? versions.find((candidate) => candidate.id === shownId) ?? null : null;
          const item: Renderable = version ? withVersion(tab, version) : tab;
          return (
          <Tabs.Content
            key={tab.id}
            value={tab.id}
            className="wb-canvas-body"
            data-renderer={item.source === 'descriptor' && item.renderer === 'preview' ? 'preview' : undefined}
            data-dense={DENSE.has(item.renderer) ? 'true' : undefined}
            data-page={item.source === 'browser' ? 'true' : undefined}
          >
            {versions.length > 1 ? (
              <VersionStepper
                versions={versions}
                current={item.id === tab.id && !version ? versions.at(-1)!.id : (version?.id ?? versions.at(-1)!.id)}
                timezone={timezone}
                onPick={(id) => setPicked((current) => ({ ...current, [`${tab.id}:${versions.length}:${tab.focus ?? ''}`]: id }))}
              />
            ) : null}
            {/* The Page tab draws on the canvas's ground, as the kit does: no panel around it. */}
            {item.source === 'browser' ? browserPanel : <section className="ui-panel" data-flush={item.source === 'descriptor' && item.renderer === 'preview' ? 'true' : undefined}>
              {item.source !== 'files' && !genericCard(item) && !(item.source === 'descriptor' && item.renderer === 'preview') ? <header className="ui-panel-head">
                <h2 className="ui-panel-title">{item.title}</h2>
                <span className="ui-panel-tool mono">{item.source === 'sources' ? sourcesSummary(item.props as SourcesPanelProps) : item.tool}</span>
              </header> : null}
              {item.tone === 'critical' ? <p className="muted">Recorded tool failure{item.at ? ` · ${fmtTime(item.at, Intl.DateTimeFormat().resolvedOptions().timeZone)}` : ''}. This is history, not live session status.</p> : null}
              {/*
                The properties panel is not a renderer and is deliberately not
                in the registry: it describes the installation rather than a
                result, and a plugin — or an agent calling `canvas.show` — must
                not be able to ask for it and fill it with whatever it likes.
                Its source is set here, in the page, and nowhere else.
              */}
              {genericCard(item) ? (
                <ToolResult
                  value={(item.props as StructuredProps).value}
                  title={item.title}
                  tool={item.tool}
                  face={cardFace}
                  timezone={timezone}
                />
              ) : item.source === 'profile' ? (
                <Profile
                  {...(item.props as ProfileProps)}
                  {...(onChangeAgent ? { onChange: onChangeAgent } : {})}
                />
              ) : item.source === 'artifact' ? (
                <ArtifactView {...(item.props as ArtifactViewProps)} />
              ) : item.source === 'files' ? (
                <FilesView {...(item.props as FilesViewProps)} />
              ) : item.source === 'sources' ? (
                <SourcesView {...(item.props as SourcesPanelProps)} timezone={timezone} />
              ) : item.source === 'notify' ? (
                <NotifyView {...(item.props as NotifyViewProps)} />
              ) : item.source === 'delegate' ? (
                <DelegateView {...(item.props as DelegateViewProps)} agents={agents ?? []} />
              ) : (
                <RenderView
                  renderer={item.renderer}
                  props={item.props}
                  timezone={timezone}
                  onDecided={onDecided}
                />
              )}
            </section>}
          </Tabs.Content>
          );
        })}
      </Tabs.Root>
    </div>
  );
}

/**
 * A result with no view of its own, that did not fail: drawn as the generic
 * tool-result card, whose head carries the title, the face and the ⋯ menu.
 */
function genericCard(item: Renderable): boolean {
  return item.renderer === 'structured'
    && (item.source === 'fallback' || item.source === 'descriptor')
    && !(item.props as StructuredProps | null)?.failed;
}

/**
 * May the owner dismiss this tab?
 *
 * Not a decision waiting on them, and not live platform state — a session
 * being driven cannot be closed from a tab strip; it is stopped with the
 * panel's own controls. Once that session is over its tab is ordinary
 * history, and history can be put away.
 */
function closeable(item: Renderable): boolean {
  if (item.source === 'approval') return false;
  if (item.source === 'browser') return item.pinned !== true;
  // The workspace is the agent's, not a moment of the conversation.
  if (item.source === 'files') return false;
  return true;
}

/**
 * How many tabs the strip has room for, from the width it actually has.
 *
 * Measured rather than assumed, because the canvas shares the window with a
 * conversation column the owner can drag: the same screen holds five tabs or
 * three depending on where that grip is. Before layout — and in jsdom, which
 * never lays out — the width is 0 and the default stands.
 */
function useTabsThatFit(forced?: number): [(node: HTMLDivElement | null) => void, number] {
  const [fits, setFits] = useState(MAX_TABS);
  const watching = useRef<ResizeObserver | null>(null);

  // A ref callback rather than an effect: the strip is a different element
  // when the canvas is empty than when it has tabs, and an effect that ran
  // once on mount would be watching a node React has since replaced.
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      watching.current?.disconnect();
      watching.current = null;
      if (!node || forced !== undefined || typeof ResizeObserver === 'undefined') return;
      const measure = (): void => {
        const width = node.clientWidth;
        if (width === 0) return;
        const room = Math.floor((width - STRIP_PADDING - OVERFLOW_WIDTH) / TAB_WIDTH);
        setFits(Math.max(MIN_TABS, Math.min(MAX_TABS, room)));
      };
      measure();
      watching.current = new ResizeObserver(measure);
      watching.current.observe(node);
    },
    [forced],
  );

  return [attach, forced === undefined ? fits : Math.min(MAX_TABS, forced)];
}

/**
 * The tab's version as the panel draws it: the tab's identity (id, tool,
 * subject), that call's result.
 */
function withVersion(tab: Renderable, version: TabVersion): Renderable {
  const view: Renderable = { ...tab, title: version.title, renderer: version.renderer, props: version.props, at: version.at, substantial: version.substantial };
  if (version.tone) view.tone = version.tone; else delete view.tone;
  return view;
}

/**
 * What each tab is called on the strip and in the timeline. A tab with a
 * subject says it already; two without one that share a title get their
 * clock, which is what tells them apart.
 */
function labelsOf(items: readonly Renderable[], timezone: string): Map<string, string> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
  const labels = new Map<string, string>();
  for (const item of items) {
    const time = item.subject || (counts.get(item.title) ?? 0) < 2 ? null : clock(item.at, timezone);
    labels.set(item.id, time ? `${item.title} · ${time}` : item.title);
  }
  return labels;
}

/**
 * The earlier results a tab holds: back and forward through the calls on its
 * subject, newest last. "Latest" says when the owner is on the newest one.
 */
function VersionStepper({
  versions,
  current,
  timezone,
  onPick,
}: {
  versions: readonly TabVersion[];
  current: string;
  timezone: string;
  onPick: (id: string) => void;
}): JSX.Element {
  const index = Math.max(0, versions.findIndex((version) => version.id === current));
  const version = versions[index]!;
  const latest = index === versions.length - 1;
  const at = clock(version.at, timezone);
  return (
    <div className="wb-versions" role="group" aria-label="Earlier results">
      <Button variant="ghost" size="sm" aria-label="Earlier result" disabled={index === 0} onClick={() => onPick(versions[index - 1]!.id)}>
        <Icon name="chevron-left" />
      </Button>
      <span className="wb-versions-text">
        {latest ? 'Latest' : 'Earlier'} · {index + 1} of {versions.length}
        {at ? <span className="mono"> · {at}</span> : null}
      </span>
      <Button variant="ghost" size="sm" aria-label="Later result" disabled={latest} onClick={() => onPick(versions[index + 1]!.id)}>
        <Icon name="chevron-right" />
      </Button>
    </div>
  );
}

/**
 * Everything the strip had no room for, as a timeline: Now, Earlier this
 * turn, Earlier, newest first in each — the menu is reached for to go
 * *back*, and back is the direction it opens in. It also closes tabs in bulk.
 */
function TabMenu({
  items,
  groups,
  labels,
  onActivate,
  onCloseAll,
  onCloseOthers,
  timezone,
}: {
  items: Renderable[];
  groups: TimelineGroup[];
  labels: ReadonlyMap<string, string>;
  onActivate: (id: string) => void;
  onCloseAll?: (() => void) | undefined;
  onCloseOthers?: (() => void) | undefined;
  timezone: string;
}): JSX.Element | null {
  if (items.length === 0 && !onCloseAll && !onCloseOthers) return null;
  const worst = items.some((item) => item.tone === 'critical')
    ? 'critical'
    : items.some((item) => item.tone === 'warning')
      ? 'warning'
      : null;

  return (
    // Not modal: this menu names tabs, it does not take the page hostage — the
    // canvas behind it stays readable and keeps its scroll position.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          className="wb-tab wb-tab-more"
          data-tone={worst ?? undefined}
          data-bare={items.length === 0 ? 'true' : undefined}
          aria-label={items.length > 0
            ? `${items.length} more ${items.length === 1 ? 'view' : 'views'} in this conversation`
            : 'Tab actions'}
        >
          {worst ? <span className="wb-tab-dot" data-tone={worst} aria-hidden="true" /> : null}
          {items.length > 0 ? <span className="wb-tab-text">{items.length} more</span> : null}
          <Icon name="chevron-down" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ui-menu" data-wide="true" align="end" sideOffset={6}>
          {groups.length > 0 ? (
            <div className="wb-tab-timeline">
              {groups.map((group) => (
                <DropdownMenu.Group key={group.label}>
                  <DropdownMenu.Label className="ui-menu-label">{group.label}</DropdownMenu.Label>
                  {group.items.map((item) => (
                    <DropdownMenu.Item
                      key={item.id}
                      className="ui-menu-item"
                      onSelect={() => onActivate(item.id)}
                    >
                      <span className="ui-menu-item-text">
                        {item.tone === 'warning' || item.tone === 'critical' ? (
                          <span className="wb-tab-dot" data-tone={item.tone} aria-hidden="true" />
                        ) : null}
                        {labels.get(item.id) ?? item.title}
                      </span>
                      {/* The clock, not the tool name: it is what places a row on the timeline. */}
                      <span className="ui-menu-note mono">{clock(item.versions?.at(-1)?.at ?? item.at, timezone) ?? item.tool}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Group>
              ))}
            </div>
          ) : null}
          {onCloseAll || onCloseOthers ? (
            <>
              {groups.length > 0 ? <DropdownMenu.Separator className="ui-menu-sep" /> : null}
              <DropdownMenu.Item className="ui-menu-item" disabled={!onCloseOthers} onSelect={() => onCloseOthers?.()}>
                <span className="ui-menu-item-text">Close others</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="ui-menu-item" disabled={!onCloseAll} onSelect={() => onCloseAll?.()}>
                <span className="ui-menu-item-text">Close all</span>
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** `09:42` in the owner's zone — a menu row has no space for a date. */
function clock(at: string | null, timezone: string): string | null {
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return fmtClock(date, timezone);
}


/** What each shape is called in the empty canvas's one line. */
const PLURAL: Record<RendererName, string> = {
  timeseries: 'charts',
  table: 'tables',
  bars: 'comparisons',
  keyvalue: 'figures',
  tiles: 'cards',
  document: 'pages it read',
  diff: 'diffs',
  terminal: 'command output',
  image: 'pictures',
  preview: 'running apps',
  envelope: 'drafts',
  story: 'stories',
  audio: 'recordings',
  query: 'results',
  structured: 'results',
};

/**
 * The empty canvas's line: whose canvas it is, and up to three things its
 * granted tools can actually draw. An agent none of whose tools declares a
 * view promises nothing, because there is nothing honest to promise.
 */
export function emptyLine(agentName: string | undefined, examples: readonly ViewDescriptor[]): string {
  const who = agentName ? `What ${agentName} shows you` : 'What your agent shows you';
  const kinds = [...new Set(examples.map((d) => PLURAL[d.renderer] ?? 'results'))].slice(0, 3);
  return kinds.length > 0 ? `${who} lands here: ${kinds.join(', ')}.` : `${who} lands here.`;
}

/** The descriptors an agent's granted tools produce, one per title, shapes varied. */
export function examplesFor(descriptors: readonly ViewDescriptor[], grantedTools: readonly string[]): ViewDescriptor[] {
  const granted = new Set(grantedTools);
  const seen = new Set<string>();
  const own = descriptors.filter((descriptor) => {
    if (!granted.has(descriptor.tool)) return false;
    const title = titleOf(descriptor);
    if (seen.has(title)) return false;
    seen.add(title);
    return true;
  });
  const shapes = new Set<string>();
  const firstOfShape = own.filter((descriptor) => {
    if (shapes.has(descriptor.renderer)) return false;
    shapes.add(descriptor.renderer);
    return true;
  });
  const rest = own.filter((descriptor) => !firstOfShape.includes(descriptor));
  return [...firstOfShape, ...rest].slice(0, MAX_EXAMPLES);
}

/** The descriptor's own title, or the tool's name turned back into words. */
function titleOf(descriptor: ViewDescriptor): string {
  if (descriptor.title && descriptor.title.trim() !== '') return descriptor.title;
  return descriptor.tool
    .split('.')
    .map((part) => part.replace(/[_-]+/g, ' '))
    .join(' · ')
    .replace(/\b\w/, (character) => character.toUpperCase());
}

/** What each renderer looks like, said in words rather than in jargon. */


/**
 * Panels read as data rather than as a result: they keep the plain surface
 * behind them instead of the page's wash, as dense pages do.
 */
const DENSE: ReadonlySet<string> = new Set(['table', 'diff', 'files']);
