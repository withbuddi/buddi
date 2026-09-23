/**
 * The renderer registry.
 *
 * Keyed by **shape**, never by tool. `timeseries`, `table`, `bars`,
 * `keyvalue`, `document`, `diff`, `terminal`, `image`, `preview`, `envelope`,
 * `structured` — eleven entries, and a default. What decides which one a given tool result gets is a view
 * descriptor the plugin declared and the server handed over as data; this file
 * has no opinion about any plugin, and an installation with no plugins still
 * ships every one of these.
 *
 * An unknown renderer name — a descriptor from a newer plugin than this
 * build — falls back to `structured` rather than an empty panel.
 */
import type { ComponentType } from 'react';
import type { ApprovalRow } from '../api';
import type {
  BarsProps,
  DiffProps,
  DocumentProps,
  EnvelopeProps,
  ImageProps,
  KeyValueProps,
  PreviewProps,
  RendererName,
  StructuredProps,
  TableProps,
  TerminalProps,
  TimeseriesProps,
} from './types';
import { Bars } from './views/Bars';
import { DiffView } from './views/DiffView';
import { DocumentView } from './views/DocumentView';
import { Envelope } from './views/Envelope';
import { ImageView } from './views/ImageView';
import { KeyValue } from './views/KeyValue';
import { PreviewView } from './views/PreviewView';
import { Structured } from './views/Structured';
import { Table } from './views/Table';
import { TerminalView } from './views/TerminalView';
import { Timeseries } from './views/Timeseries';

/** Everything a renderer may be handed. Only `envelope` uses the extras. */
export interface RendererContext {
  timezone?: string;
  onDecided?: (action: ApprovalRow) => void;
}

/**
 * Every renderer takes the same two things: props it can trust, and the small
 * context only `envelope` uses. The props type is erased at the registry
 * boundary — resolution happened upstream, and a map keyed by name cannot also
 * be keyed by prop type.
 */
export type RendererComponent = ComponentType<{ props: never } & RendererContext>;

const erase = <P,>(component: ComponentType<{ props: P } & RendererContext>): RendererComponent =>
  component as unknown as RendererComponent;

/** The map. Adding a renderer means adding a line here and a file beside it. */
export const RENDERERS: Record<RendererName, RendererComponent> = {
  timeseries: erase<TimeseriesProps>(Timeseries),
  table: erase<TableProps>(Table),
  bars: erase<BarsProps>(Bars),
  keyvalue: erase<KeyValueProps>(KeyValue),
  document: erase<DocumentProps>(DocumentView),
  diff: erase<DiffProps>(DiffView),
  terminal: erase<TerminalProps>(TerminalView),
  image: erase<ImageProps>(ImageView),
  preview: erase<PreviewProps>(PreviewView),
  envelope: erase<EnvelopeProps>(Envelope),
  structured: erase<StructuredProps>(Structured),
};

export const DEFAULT_RENDERER: RendererName = 'structured';

/** The component for a renderer name, or the default when nobody claims it. */
export function rendererFor(name: string): RendererComponent {
  const known = isKnownRenderer(name) ? RENDERERS[name] : undefined;
  return known ?? RENDERERS[DEFAULT_RENDERER];
}

/** True when this build knows how to draw that name. */
export function isKnownRenderer(name: string): name is RendererName {
  return Object.prototype.hasOwnProperty.call(RENDERERS, name);
}

/**
 * Draw one renderable. Props were resolved before they got here, so a renderer
 * never sees a raw tool result and never sees a descriptor.
 */
export function RenderView({
  renderer,
  props,
  timezone,
  onDecided,
}: { renderer: string; props: unknown } & RendererContext): JSX.Element {
  const Component = rendererFor(renderer);
  const known = isKnownRenderer(renderer);
  // An unknown name still shows the data, and says why it looks plain.
  const resolved = known ? props : { value: props };
  return <Component props={resolved as never} timezone={timezone} onDecided={onDecided} />;
}
