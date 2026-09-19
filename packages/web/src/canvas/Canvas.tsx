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
 * descriptors actually installed on this machine — real titles from real
 * plugins, arriving as data over `GET /api/chat/views` — so a fresh install
 * with one plugin promises one thing, and this file still knows the name of no
 * tool at all.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tabs from '@radix-ui/react-tabs';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { ApprovalRow } from '../api';
import { RenderView } from './registry';
import type { Renderable, RendererName, ViewDescriptor } from './types';
import { Profile, type ProfileProps } from './views/Profile';

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
  agentName,
  maxTabs,
  browserPanel,
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
  agentName?: string;
  /** Forces how many tabs fit, for tests: jsdom lays nothing out and measures 0. */
  maxTabs?: number;
  /** Live host state supplied by the page, never by tool-result props. */
  browserPanel?: ReactNode;
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
              <FrameIcon />
            </span>
            <h2 className="wb-empty-title">
              {agentName ? `What ${agentName} finds is drawn here` : 'What the run finds is drawn here'}
            </h2>
            <p className="wb-empty-body">
              {emptyHint ?? 'Ask for something. Whatever the run looks at will be drawn here.'}
            </p>
            <Examples descriptors={descriptors ?? []} />
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
                onKeyDown={event => { if (event.key === 'Delete' && onClose && item.source !== 'approval' && item.source !== 'browser') { event.preventDefault(); onClose(item.id); } }}>
                {item.tone === 'warning' || item.tone === 'critical' ? (
                  <span className="wb-tab-dot" data-tone={item.tone} aria-hidden="true" />
                ) : null}
                <span className="wb-tab-text">{item.title}</span>
              </Tabs.Trigger>
              {onClose && item.source !== 'approval' && item.source !== 'browser' ? <button className="wb-tab-close" aria-label={`Close ${item.title} tab`} title="Dismiss panel; keep conversation history" onClick={() => onClose(item.id)}>×</button> : null}
              </div>
            ))}
          </Tabs.List>
          <MoreTabs items={hidden} onActivate={onActivate} timezone={timezone} />
        </div>
        {renderables.map((item) => (
          <Tabs.Content key={item.id} value={item.id} className="wb-canvas-body">
            <section className="ui-panel">
              {item.source !== 'browser' ? <header className="ui-panel-head">
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
      .filter((item) => item.id === activeId || item.source === 'approval')
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
          <ChevronIcon />
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

function ChevronIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" {...stroke}>
      <path d="M4 5.5 7 8.5l3-3" />
    </svg>
  );
}

/**
 * Two or three things this installation can actually draw, each shown as the
 * shape it would take. With no plugin installed there is nothing honest to
 * promise, so nothing is promised.
 */
function Examples({ descriptors }: { descriptors: ViewDescriptor[] }): JSX.Element | null {
  const seen = new Set<string>();
  const examples = descriptors
    .filter((descriptor) => {
      const title = titleOf(descriptor);
      if (seen.has(title)) return false;
      seen.add(title);
      return true;
    })
    .slice(0, MAX_EXAMPLES);

  if (examples.length === 0) return null;

  return (
    <>
      <p className="wb-empty-lead">Things it can put here:</p>
      <ul className="wb-empty-list">
        {examples.map((descriptor) => (
          <li key={descriptor.tool} className="wb-empty-item">
            <span className="wb-empty-icon" aria-hidden="true">
              <ShapeIcon renderer={descriptor.renderer} />
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
  envelope: 'a decision to make',
  structured: 'the result, laid out',
};

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** Each renderer drawn as the mark it makes. */
function ShapeIcon({ renderer }: { renderer: RendererName }): JSX.Element {
  const path = SHAPE_PATHS[renderer] ?? SHAPE_PATHS.structured;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      {path}
    </svg>
  );
}

const SHAPE_PATHS: Record<RendererName, JSX.Element> = {
  timeseries: <path d="M2 11.5 5.4 7.2l2.6 2.2L14 3.5" />,
  table: <path d="M2.2 3.5h11.6v9H2.2zM2.2 6.6h11.6M6.6 6.6v5.9" />,
  bars: <path d="M3 13V8.2M7 13V3.6M11 13V6.4M2 13.6h12" />,
  keyvalue: <path d="M2.6 4.6h4M9.4 4.6h4M2.6 8h4M9.4 8h4M2.6 11.4h4M9.4 11.4h4" />,
  document: <path d="M4 2.4h5l3 3v8.2H4zM9 2.4v3h3M6 9h4M6 11.2h3" />,
  envelope: <path d="M2.2 4h11.6v8H2.2zM2.2 4.4 8 8.8l5.8-4.4" />,
  structured: <path d="M4 2.6h8v10.8H4zM6.2 5.6h3.6M6.2 8h3.6M6.2 10.4h2.2" />,
};

function FrameIcon(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" {...stroke} strokeWidth={1.3}>
      <rect x="2.6" y="3.6" width="16.8" height="14.8" rx="2" />
      <path d="M2.6 14.2 7.4 9.6l3.4 3 3-2.6 3.6 3.2" />
      <circle cx="7.4" cy="7.6" r="1.2" />
    </svg>
  );
}
