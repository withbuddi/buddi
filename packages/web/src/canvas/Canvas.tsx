/**
 * The canvas: tabs across the top holding the last few things this
 * conversation produced, one panel below.
 *
 * The tabs exist so that reading an approval does not cost you the chart you
 * were looking at. They are ordered oldest-first, like the conversation, and
 * the newest is selected unless the owner has moved.
 *
 * **The strip is capped.** A long conversation produces more tabs than fit, and
 * tabs that do not fit are worse than no tabs: they shrink to nothing, or the
 * bar scrolls sideways and what is on it stops being visible at a glance. So
 * the strip holds as many as the width actually has room for — four or five on
 * a laptop, two on a phone — and the rest go behind one control that names
 * them. Two things are never pushed off it: what the owner is looking at, and
 * a decision waiting to be made. A failure can be pushed off, but not
 * silently: the control wears its dot.
 *
 * Empty, it teaches rather than apologises. The things it names are the view
 * descriptors of the tools this conversation's agent is granted — real titles
 * from real plugins, arriving as data over `GET /api/chat/views` and matched
 * against the agent's resolved grant — so the Illustrator promises a picture
 * and not a balance, and this file still knows the name of no tool at all.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tabs from '@radix-ui/react-tabs';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { ApprovalRow } from '../api';
import { RenderView } from './registry';
import type { Renderable, RendererName, ViewDescriptor } from './types';
import { Profile, type ProfileProps } from './views/Profile';
import { ArtifactView, type ArtifactViewProps } from './views/ArtifactView';
import { DelegateView, type DelegateViewProps } from './views/DelegateView';
import { FilesView, type FilesViewProps } from './views/FilesView';
import type { ChatAgent } from '../chat/types';
import { Icon, ICON_NAMES, type IconName } from '../ui/Icon';

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

/** The strip's own side padding, which is not available to tabs. */
const STRIP_PADDING = 28;

/**
 * Never fewer than two, so a strip still reads as a strip on a phone, and
 * never more than five, because a sixth tab is further away than the menu.
 */
const MIN_TABS = 2;
const MAX_TABS = 5;

export function Canvas({
  renderables,
  activeId,
  onActivate,
  timezone,
  onDecided,
  onChangeAgent,
  emptyHint,
  descriptors,
  grantedTools,
  agentName,
  maxTabs,
  browserPanel,
  agents,
  onClose,
}: {
  renderables: Renderable[];
  activeId: string | null;
  onActivate: (id: string) => void;
  timezone: string;
  onDecided?: (action: ApprovalRow) => void;
  /** Where the properties panel's one button goes: the maker, with a subject. */
  onChangeAgent?: ProfileProps['onChange'];
  emptyHint?: string;
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
  /**
   * The roster, for the one panel that draws another agent: a delegation.
   * Supplied by the page — a name and a face are the page's to give, never a
   * tool result's.
   */
  agents?: readonly ChatAgent[];
  onClose?: (id: string) => void;
}): JSX.Element {
  const [strip, fits] = useTabsThatFit(maxTabs);
  if (renderables.length === 0) {
    return (
      <div className="wb-canvas" data-testid="canvas">
        <div className="wb-canvas-tabs" ref={strip} aria-hidden="true">
          <span className="wb-canvas-label">Canvas</span>
        </div>
        <div className="wb-canvas-body wb-canvas-body-empty">
          <div className="wb-empty">
            <span className="wb-empty-mark" aria-hidden="true">
              <Icon name="frame" />
            </span>
            <h2 className="wb-empty-title">
              {agentName ? `What ${agentName} finds is drawn here` : 'What the run finds is drawn here'}
            </h2>
            <p className="wb-empty-body">
              {emptyHint ?? 'Ask for something. Whatever the run looks at will be drawn here.'}
            </p>
            <Examples descriptors={descriptors ?? []} grantedTools={grantedTools ?? []} />
          </div>
        </div>
      </div>
    );
  }

  const active = renderables.some((item) => item.id === activeId)
    ? (activeId as string)
    : (renderables[renderables.length - 1]!.id);

  const { shown, hidden } = splitTabs(renderables, active, fits);

  return (
    <div className="wb-canvas" data-testid="canvas">
      <Tabs.Root value={active} onValueChange={onActivate} className="contents">
        <div className="wb-canvas-tabs" ref={strip}>
          <Tabs.List className="wb-tabstrip" aria-label="Canvas">
            {shown.map((item) => (
              <div key={item.id} className="wb-tab-item">
              <Tabs.Trigger value={item.id} className="wb-tab" data-tone={item.tone}
                onKeyDown={event => { if (event.key === 'Delete' && onClose && closeable(item)) { event.preventDefault(); onClose(item.id); } }}>
                {item.tone === 'warning' || item.tone === 'critical' ? (
                  <span className="wb-tab-dot" data-tone={item.tone} aria-hidden="true" />
                ) : null}
                <span className="wb-tab-text">{item.title}</span>
              </Tabs.Trigger>
              {onClose && closeable(item) ? <button className="wb-tab-close" aria-label={`Close ${item.title} tab`} title="Dismiss panel; keep conversation history" onClick={() => onClose(item.id)}>×</button> : null}
              </div>
            ))}
          </Tabs.List>
          <MoreTabs items={hidden} onActivate={onActivate} timezone={timezone} />
        </div>
        {renderables.map((item) => (
          <Tabs.Content
            key={item.id}
            value={item.id}
            className="wb-canvas-body"
            data-renderer={item.source === 'descriptor' && item.renderer === 'preview' ? 'preview' : undefined}
            data-dense={DENSE.has(item.renderer) ? 'true' : undefined}
          >
            <section className="ui-panel" data-flush={item.source === 'descriptor' && item.renderer === 'preview' ? 'true' : undefined}>
              {item.source !== 'browser' && item.source !== 'files' && !(item.source === 'descriptor' && item.renderer === 'preview') ? <header className="ui-panel-head">
                <h2 className="ui-panel-title">{item.title}</h2>
                <span className="ui-panel-tool mono">{item.tool}</span>
              </header> : null}
              {item.tone === 'critical' ? <p className="muted">Recorded tool failure{item.at ? ` · ${new Date(item.at).toLocaleString()}` : ''}. This is history, not live session status.</p> : null}
              {/*
                The properties panel is not a renderer and is deliberately not
                in the registry: it describes the installation rather than a
                result, and a plugin — or an agent calling `canvas.show` — must
                not be able to ask for it and fill it with whatever it likes.
                Its source is set here, in the page, and nowhere else.
              */}
              {item.source === 'browser' ? browserPanel : item.source === 'profile' ? (
                <Profile
                  {...(item.props as ProfileProps)}
                  {...(onChangeAgent ? { onChange: onChangeAgent } : {})}
                />
              ) : item.source === 'artifact' ? (
                <ArtifactView {...(item.props as ArtifactViewProps)} />
              ) : item.source === 'files' ? (
                <FilesView {...(item.props as FilesViewProps)} />
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
            </section>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  );
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

  return [attach, forced ?? fits];
}

/**
 * Which tabs are on the strip and which are behind the menu.
 *
 * The recent ones are on the strip, because that is where the conversation
 * is. Two claims beat recency: the tab being read, since moving it would move
 * the screen out from under a reader, and a decision waiting on the owner,
 * since that is the one thing here they have to answer. Those two can together
 * exceed the room; they still both show, because the alternative is hiding
 * one of them.
 *
 * A third claim is the same kind of thing: platform state the page has marked
 * as *happening now* — the screen an agent is driving — which holds the strip
 * until it stops being live.
 *
 * A failure is not pinned — it would crowd out the work — but it is never
 * silent either: the menu carries its red dot, so the strip says a failure is
 * back there before it is opened.
 */
export function splitTabs(
  renderables: Renderable[],
  activeId: string,
  fits: number,
): { shown: Renderable[]; hidden: Renderable[] } {
  const pinned = new Set(
    renderables
      .filter((item) => item.id === activeId || item.source === 'approval' || item.pinned === true)
      .map((item) => item.id),
  );

  const keep = new Set(pinned);
  for (let index = renderables.length - 1; index >= 0 && keep.size < fits; index -= 1) {
    keep.add(renderables[index]!.id);
  }

  return {
    shown: renderables.filter((item) => keep.has(item.id)),
    hidden: renderables.filter((item) => !keep.has(item.id)),
  };
}

/**
 * Everything the strip had no room for, named. Newest first — the menu is
 * reached for to go *back*, and back is the direction it opens in.
 */
function MoreTabs({
  items,
  onActivate,
  timezone,
}: {
  items: Renderable[];
  onActivate: (id: string) => void;
  timezone: string;
}): JSX.Element | null {
  if (items.length === 0) return null;
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
          aria-label={`${items.length} more ${items.length === 1 ? 'view' : 'views'} in this conversation`}
        >
          {worst ? <span className="wb-tab-dot" data-tone={worst} aria-hidden="true" /> : null}
          <span className="wb-tab-text">{items.length} more</span>
          <Icon name="chevron-down" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="ui-menu" data-wide="true" align="end" sideOffset={6}>
          <DropdownMenu.Label className="ui-menu-label">Earlier in this conversation</DropdownMenu.Label>
          {[...items].reverse().map((item) => (
            <DropdownMenu.Item
              key={item.id}
              className="ui-menu-item"
              onSelect={() => onActivate(item.id)}
            >
              <span className="ui-menu-item-text">
                {item.tone === 'warning' || item.tone === 'critical' ? (
                  <span className="wb-tab-dot" data-tone={item.tone} aria-hidden="true" />
                ) : null}
                {item.title}
              </span>
              {/* The clock, not the tool name: a run that called one tool four
                  times makes four rows with the same title, and the time is
                  what tells them apart. */}
              <span className="ui-menu-note mono">{clock(item.at, timezone) ?? item.tool}</span>
            </DropdownMenu.Item>
          ))}
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
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}


/**
 * Two or three things this agent can actually draw, each shown as the shape
 * it would take: the view descriptors of the tools it is granted, and nothing
 * else. An agent none of whose tools declares a view — or a canvas that does
 * not know whose it is — promises nothing, because there is nothing honest to
 * promise. Different shapes come first, so an agent that can draw a diff and
 * a terminal says both rather than three kinds of table.
 */
export function Examples({
  descriptors,
  grantedTools,
}: {
  descriptors: ViewDescriptor[];
  grantedTools: readonly string[];
}): JSX.Element | null {
  const examples = examplesFor(descriptors, grantedTools);
  if (examples.length === 0) return null;

  return (
    <>
      <p className="wb-empty-lead">Things it can put here:</p>
      <ul className="wb-empty-list">
        {examples.map((descriptor) => (
          <li key={descriptor.tool} className="wb-empty-item">
            <span className="wb-empty-icon" aria-hidden="true">
              <Icon name={shapeIcon(descriptor.renderer)} />
            </span>
            <span className="wb-empty-item-text">
              <span className="wb-empty-item-title">{titleOf(descriptor)}</span>
              <span className="wb-empty-item-shape">{SHAPE[descriptor.renderer] ?? 'a view'}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
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
const SHAPE: Record<RendererName, string> = {
  timeseries: 'a line over time',
  table: 'a table of rows',
  bars: 'a bar comparison',
  keyvalue: 'a list of figures',
  document: 'a document to read',
  diff: 'a change to review',
  terminal: 'what a command printed',
  image: 'a picture',
  preview: 'the app, running',
  envelope: 'a decision to make',
  structured: 'the result, laid out',
};

/** Each renderer drawn as the mark it makes; an unknown one as a structured result. */
function shapeIcon(renderer: RendererName): IconName {
  const name = `shape-${renderer}`;
  return (ICON_NAMES as string[]).includes(name) ? (name as IconName) : 'shape-structured';
}

/**
 * Panels read as data rather than as a result: they keep the plain surface
 * behind them instead of the page's wash, as dense pages do.
 */
const DENSE: ReadonlySet<string> = new Set(['table', 'diff', 'files']);
