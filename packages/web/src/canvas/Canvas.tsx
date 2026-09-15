/**
 * The canvas: tabs across the top holding the last few things this
 * conversation produced, one panel below.
 *
 * The tabs exist so that reading an approval does not cost you the chart you
 * were looking at. They are ordered oldest-first, like the conversation, and
 * the newest is selected unless the owner has moved.
 *
 * Empty, it teaches rather than apologises. The things it names are the view
 * descriptors actually installed on this machine — real titles from real
 * plugins, arriving as data over `GET /api/chat/views` — so a fresh install
 * with one plugin promises one thing, and this file still knows the name of no
 * tool at all.
 */
import * as Tabs from '@radix-ui/react-tabs';
import type { ApprovalRow } from '../api';
import { RenderView } from './registry';
import type { Renderable, RendererName, ViewDescriptor } from './types';

/** How many examples the empty state names. Two or three teach; eight lecture. */
const MAX_EXAMPLES = 3;

export function Canvas({
  renderables,
  activeId,
  onActivate,
  timezone,
  onDecided,
  emptyHint,
  descriptors,
  agentName,
}: {
  renderables: Renderable[];
  activeId: string | null;
  onActivate: (id: string) => void;
  timezone: string;
  onDecided?: (action: ApprovalRow) => void;
  emptyHint?: string;
  /** The installed view descriptors, used to say what could appear here. */
  descriptors?: ViewDescriptor[];
  agentName?: string;
}): JSX.Element {
  if (renderables.length === 0) {
    return (
      <div className="wb-canvas" data-testid="canvas">
        <div className="wb-canvas-tabs" aria-hidden="true">
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

  return (
    <div className="wb-canvas" data-testid="canvas">
      <Tabs.Root value={active} onValueChange={onActivate} className="contents">
        <Tabs.List className="wb-canvas-tabs" aria-label="Canvas">
          {renderables.map((item) => (
            <Tabs.Trigger key={item.id} value={item.id} className="wb-tab" data-tone={item.tone}>
              {item.tone === 'warning' || item.tone === 'critical' ? (
                <span className="wb-tab-dot" data-tone={item.tone} aria-hidden="true" />
              ) : null}
              {item.title}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {renderables.map((item) => (
          <Tabs.Content key={item.id} value={item.id} className="wb-canvas-body">
            <section className="wb-panel">
              <header className="wb-panel-head">
                <h2 className="wb-panel-title">{item.title}</h2>
                <span className="wb-panel-tool mono">{item.tool}</span>
              </header>
              <RenderView
                renderer={item.renderer}
                props={item.props}
                timezone={timezone}
                onDecided={onDecided}
              />
            </section>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
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
