/**
 * Home's Widgets section: small live panels the plugins export, in the
 * owner's order and sizes (kit: ui_kits/dashboard/Widgets.jsx).
 *
 * It sits under Needs you: what needs the owner stays first, and when nothing
 * does the widgets are right under the composer. A frame is a Home card —
 * title, a stale mark, a ⋯ menu — around a body from five kinds (stat, list,
 * strip, progress, text) the gateway has already checked and cut to size.
 * Nothing here knows a plugin: glyphs from the pinned set, formatted text.
 *
 * Arranging: the ⋯ menu moves, resizes and hides one at once (a hide leaves
 * "<Title> hidden · Undo" in its place for a few seconds); Edit turns every
 * frame into one that can be dragged by its grip (or moved with the arrow keys
 * on it, or its ‹ › buttons, up and down on a phone), resized or taken off, and
 * lists what can be added; Done saves, Cancel puts it back.
 */
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { api, type WidgetBody, type WidgetInfo, type WidgetLayoutItem, type WidgetSize, type WidgetsAnswer, type WidgetView } from '../../api';
import { tileGlyph } from '../../canvas/tileIcons';
import { fmtRelative, fmtShortRelative } from '../../format';
import { pluginPageHref } from '../../pages/pageLinks';
import { ActionMenu, Button, Icon, Notice, useAsync } from '../../ui';
import { GLANCE_UNDO_MS, Spark } from './HomeGlances';

/** How often Home asks again; each widget is produced on its own refresh behind it. */
export const WIDGETS_POLL_MS = 60_000;

/** Rows a list draws, and tiles a strip draws, by size. */
const ROWS = 3;
const TILES: Record<WidgetSize, number> = { small: 4, medium: 6 };

/** How many frames to hold while the first answer comes: the last layout's length, per browser. */
const COUNT_KEY = 'buddi.home.widgets';

function readCount(): number {
  try {
    const n = Number(window.localStorage.getItem(COUNT_KEY));
    return Number.isInteger(n) && n > 0 ? Math.min(n, 6) : 0;
  } catch {
    return 0;
  }
}

function writeCount(n: number): void {
  try {
    window.localStorage.setItem(COUNT_KEY, String(n));
  } catch {
    /* A private window: the next load draws no placeholders, nothing else. */
  }
}

/** The widgets answer, kept current by a poll and by every save. */
export function useWidgets(): {
  answer: WidgetsAnswer | undefined;
  error: string | null;
  apply: (answer: WidgetsAnswer) => void;
  reload: () => void;
} {
  const polled = useAsync(() => api.widgets(), [], WIDGETS_POLL_MS);
  const [answer, setAnswer] = useState<WidgetsAnswer | undefined>(undefined);
  useEffect(() => {
    if (polled.data) setAnswer(polled.data);
  }, [polled.data]);
  useEffect(() => {
    if (answer) writeCount(answer.layout.length);
  }, [answer]);
  return { answer, error: polled.error, apply: setAnswer, reload: polled.reload };
}

/** The ids on Home now: a glance sharing one stays off the date line. */
export function placedIds(answer: WidgetsAnswer | undefined): ReadonlySet<string> {
  return new Set((answer?.layout ?? []).map((item) => item.id));
}

/* ------------------------------------------------------------------ *
 * Bodies
 * ------------------------------------------------------------------ */

function Glyph({ icon, size }: { icon?: string | undefined; size: number }): JSX.Element | null {
  return icon ? <span className="wg-icon"><Icon name={tileGlyph(icon)} size={size} /></span> : null;
}

export function WidgetBodyView({ body, size }: { body: WidgetBody; size: WidgetSize }): JSX.Element {
  switch (body.kind) {
    case 'stat':
      return (
        <>
          <span className="wg-stat-now"><Glyph icon={body.icon} size={24} /><span className="wg-value">{body.value}</span></span>
          {body.caption ? <span className="wg-caption">{body.caption}</span> : null}
          <span className="wg-push" />
          {body.trend ? (
            <span className="wg-trend">
              <Spark points={body.trend.points} className="wg-spark" />
              {body.trend.label ? <span>{body.trend.label}</span> : null}
            </span>
          ) : null}
          {body.foot ? <span className="wg-foot">{body.foot}</span> : null}
        </>
      );
    case 'list':
      return (
        <>
          <ul className="wg-list">
            {body.rows.slice(0, ROWS).map((row, i) => (
              <li key={`${row.title}-${i}`} className="wg-row">
                <span className="wg-row-text">
                  <span className="wg-row-title">{row.title}</span>
                  {row.sub && size === 'medium' ? <span className="wg-row-sub">{row.sub}</span> : null}
                </span>
                {row.side ? <span className="wg-row-side" data-tone={row.tone}>{row.side}</span> : null}
              </li>
            ))}
          </ul>
          <span className="wg-push" />
          {body.more ? <span className="wg-foot">{body.more}</span> : null}
        </>
      );
    case 'strip':
      return (
        <>
          <span className="wg-strip-head">
            <Glyph icon={body.icon} size={20} />
            {body.value ? <span className="wg-strip-value">{body.value}</span> : null}
            {body.caption ? <span className="wg-caption">{body.caption}</span> : null}
          </span>
          <span className="wg-push" />
          <span className="wg-strip">
            {body.items.slice(0, TILES[size]).map((item, i) => (
              <span key={`${item.label}-${i}`} className="wg-tile">
                <span className="wg-tile-label">{item.label}</span>
                <Glyph icon={item.icon} size={18} />
                <span className="wg-tile-value">{item.value}</span>
              </span>
            ))}
          </span>
        </>
      );
    case 'progress': {
      const percent = Math.round(Math.max(0, Math.min(1, body.ratio)) * 100);
      return (
        <>
          <span className="wg-value">{body.value}</span>
          {body.caption ? <span className="wg-caption">{body.caption}</span> : null}
          <span className="wg-push" />
          <span className="ui-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={body.caption ?? body.value}>
            <span className="ui-meter-fill" data-tone={body.tone} style={{ inlineSize: `${percent}%` }} />
          </span>
          {body.foot ? <span className="wg-foot">{body.foot}</span> : null}
        </>
      );
    }
    case 'text':
      return (
        <span className="wg-text">
          {body.icon ? <span className="wg-text-icon"><Icon name={tileGlyph(body.icon)} size={18} /></span> : null}
          <span className="wg-text-words">
            <span className="wg-text-main">{body.text}</span>
            {body.sub ? <span className="wg-row-sub">{body.sub}</span> : null}
          </span>
        </span>
      );
  }
}

/* ------------------------------------------------------------------ *
 * The frame
 * ------------------------------------------------------------------ */

type Act = 'earlier' | 'later' | 'size' | 'hide' | 'edit';

interface FrameProps {
  info: WidgetInfo;
  item: WidgetLayoutItem;
  view: WidgetView | undefined;
  index: number;
  count: number;
  editing: boolean;
  navigate: (route: string) => void;
  act: (what: Act, size?: WidgetSize) => void;
  onRetry: () => void;
  retrying: boolean;
  drag: DragState;
}

interface DragState {
  dragging: string | null;
  over: string | null;
  start: (id: string) => void;
  enter: (id: string) => void;
  drop: (id: string) => void;
  end: () => void;
}

/** A sensitive body, shown on asking and hidden again when the window loses the owner. */
function useReveal(sensitive: boolean): [boolean, (v: boolean) => void] {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!sensitive || !shown) return undefined;
    const hide = (): void => { if (document.visibilityState === 'hidden' || !document.hasFocus()) setShown(false); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', hide);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('blur', hide); };
  }, [sensitive, shown]);
  return [shown, setShown];
}

function WidgetFrame({ info, item, view, index, count, editing, navigate, act, onRetry, retrying, drag }: FrameProps): JSX.Element {
  const [shown, setShown] = useReveal(info.sensitive === true);
  const state = view?.state ?? 'error';
  const masked = info.sensitive === true && !shown;
  const href = info.link ? pluginPageHref(info.link.plugin, info.link.page, info.link.place) : null;
  const linked = href !== null && !editing && state !== 'error' && !masked;
  const other: WidgetSize = item.size === 'small' ? 'medium' : 'small';

  let inner: ReactNode;
  if (!view && editing) {
    // Just added from the gallery: it is produced once the layout is saved.
    inner = <span className="wg-state"><span className="wg-state-sub">Fills in when you press Done.</span></span>;
  } else if (state === 'error' || !view) {
    inner = (
      <span className="wg-state">
        <span className="wg-state-title">Couldn't load this.</span>
        {view?.error ? <span className="wg-state-sub">{capital(view.error)}.</span> : null}
        {editing ? null : <Button size="sm" onClick={onRetry} disabled={retrying}>{retrying ? 'Trying…' : 'Try again'}</Button>}
      </span>
    );
  } else if (state === 'empty' || !view.body) {
    inner = <span className="wg-state"><span className="wg-state-sub">Nothing to show right now.</span></span>;
  } else if (masked) {
    inner = (
      <span className="wg-state">
        <span className="wg-mask" aria-hidden="true">••••</span>
        <span className="wg-state-sub">Hidden on this screen.</span>
        {editing ? null : <Button size="sm" onClick={() => setShown(true)}>Show</Button>}
      </span>
    );
  } else {
    inner = <WidgetBodyView body={view.body} size={item.size} />;
  }

  const onDragStart = (event: DragEvent<HTMLDivElement>): void => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', info.id);
    drag.start(info.id);
  };

  return (
    <div
      className="wg-frame"
      role="group"
      aria-label={info.title}
      data-id={info.id}
      data-size={item.size}
      data-state={state === 'ok' ? undefined : state}
      data-linked={linked ? 'true' : undefined}
      data-dragging={drag.dragging === info.id ? 'true' : undefined}
      data-over={drag.over === info.id && drag.dragging !== info.id ? 'true' : undefined}
      draggable={editing ? true : undefined}
      onDragStart={editing ? onDragStart : undefined}
      onDragOver={editing ? (event) => { if (drag.dragging) { event.preventDefault(); drag.enter(info.id); } } : undefined}
      onDrop={editing ? (event) => { event.preventDefault(); drag.drop(info.id); } : undefined}
      onDragEnd={editing ? () => drag.end() : undefined}
    >
      <div className="wg-head">
        {editing ? (
          <button
            type="button"
            className="ui-icon-btn wg-grip"
            data-size="sm"
            data-grip={info.id}
            aria-label={`Move ${info.title}, position ${index + 1} of ${count}: arrow keys`}
            title="Drag, or use the arrow keys"
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); act('earlier'); }
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); act('later'); }
            }}
          >
            <Icon name="grip" size={14} />
          </button>
        ) : null}
        <span className="wg-title">{info.title}</span>
        {state === 'stale' ? (
          <span className="wg-stale" title={view?.error ? `Couldn't refresh: ${view.error}.` : undefined}>
            {view?.updatedAt ? `${fmtShortRelative(view.updatedAt)} old` : 'Not current'}
          </span>
        ) : null}
        {editing ? (
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label={`Take ${info.title} off Home`} title="Take off Home" onClick={() => act('hide')}>
            <Icon name="close" size={12} />
          </button>
        ) : (
          <span className="wg-more">
            <ActionMenu
              label={`More for ${info.title}`}
              note={view?.updatedAt ? `${info.plugin} · ${fmtRelative(view.updatedAt)}` : info.plugin}
              items={[
                index > 0 ? { label: 'Move earlier', onSelect: () => act('earlier') } : null,
                index < count - 1 ? { label: 'Move later', onSelect: () => act('later') } : null,
                info.sizes.includes(other) ? { label: `Make it ${other}`, onSelect: () => act('size', other) } : null,
                { label: 'Edit widgets', onSelect: () => act('edit') },
                'separator',
                { label: 'Hide from Home', onSelect: () => act('hide') },
              ]}
            />
          </span>
        )}
      </div>
      {linked ? (
        <a className="wg-body" href={href} onClick={(event) => { event.preventDefault(); navigate(href); }}>{inner}</a>
      ) : (
        <div className="wg-body">{inner}</div>
      )}
      {editing ? (
        <div className="wg-edit-bar">
          {info.sizes.length > 1 ? (
            <span className="ui-segment" role="radiogroup" aria-label={`Size of ${info.title}`}>
              {(['small', 'medium'] as const).filter((s) => info.sizes.includes(s)).map((s) => (
                <button key={s} type="button" className="ui-tab" role="radio" aria-checked={item.size === s} onClick={() => act('size', s)}>
                  {s === 'small' ? 'Small' : 'Medium'}
                </button>
              ))}
            </span>
          ) : (
            <span className="wg-edit-note">{info.sizes[0] === 'small' ? 'Small only' : 'Medium only'}</span>
          )}
          <span className="wg-edit-move">
            <button type="button" className="ui-icon-btn" data-size="sm" data-move={`${info.id}:earlier`} aria-label={`Move ${info.title} earlier`} title="Move earlier" disabled={index === 0} onClick={() => act('earlier')}>
              <Icon name="chevron-left" />
            </button>
            <button type="button" className="ui-icon-btn" data-size="sm" data-move={`${info.id}:later`} aria-label={`Move ${info.title} later`} title="Move later" disabled={index === count - 1} onClick={() => act('later')}>
              <Icon name="chevron-right" />
            </button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function capital(text: string): string {
  const t = text.replace(/\.$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* ------------------------------------------------------------------ *
 * The section
 * ------------------------------------------------------------------ */

export function HomeWidgets({
  widgets,
  navigate,
}: {
  widgets: ReturnType<typeof useWidgets>;
  navigate: (route: string) => void;
}): JSX.Element | null {
  const { answer, apply } = widgets;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WidgetLayoutItem[]>([]);
  const [undo, setUndo] = useState<{ item: WidgetLayoutItem; at: number } | null>(null);
  const [said, setSaid] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [placeholders] = useState(readCount);
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    if (!undo) return undefined;
    const timer = window.setTimeout(() => setUndo(null), GLANCE_UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);

  // After a keyboard move, the focus stays on what moved it.
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    document.querySelector<HTMLElement>(`[data-grip="${CSS.escape(target)}"], [data-move="${CSS.escape(target)}"]`)?.focus();
  });

  if (!answer) {
    if (placeholders === 0) return null;
    return (
      <section className="ui-section wg-section" aria-label="Widgets" aria-busy="true">
        <div className="ui-section-head"><h3 className="ui-section-title">Widgets</h3></div>
        <div className="wg-grid">
          {Array.from({ length: placeholders }, (_, i) => (
            <div key={i} className="wg-frame" data-state="loading" aria-hidden="true">
              <div className="wg-head" />
              <span className="wg-skel-body"><span className="wg-skel" data-w="half" /><span className="wg-skel" data-w="third" /><span className="wg-push" /><span className="wg-skel" /></span>
            </div>
          ))}
        </div>
      </section>
    );
  }

  // Nothing any plugin offers: no section, no advert for an empty feature.
  if (answer.available.length === 0) return null;

  const byId = new Map(answer.available.map((w) => [w.id, w]));
  const layout = editing ? draft : answer.layout;
  const titleOf = (id: string): string => byId.get(id)?.title ?? id;

  /** Save a layout: drawn at once, put back if the save fails. */
  const save = (next: WidgetLayoutItem[], previous: WidgetsAnswer): Promise<boolean> => {
    setFailure(null);
    apply({ ...previous, layout: next, arranged: true });
    return api.saveWidgetLayout(next).then(
      (saved) => { apply(saved); return true; },
      (err: unknown) => {
        apply(previous);
        setFailure(`Couldn't save your widgets: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      },
    );
  };

  const moved = (list: WidgetLayoutItem[], from: number, to: number): WidgetLayoutItem[] | null => {
    if (to < 0 || to >= list.length || from === to) return null;
    const next = list.slice();
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it!);
    setSaid(`${titleOf(it!.id)}, position ${to + 1} of ${next.length}.`);
    return next;
  };

  const startEdit = (): void => {
    setDraft(answer.layout);
    setUndo(null);
    setFailure(null);
    setEditing(true);
  };

  const act = (index: number) => (what: Act, size?: WidgetSize): void => {
    const item = layout[index]!;
    if (what === 'edit') { startEdit(); return; }
    if (editing) {
      if (what === 'earlier' || what === 'later') {
        const next = moved(draft, index, what === 'earlier' ? index - 1 : index + 1);
        if (next) {
          const active = document.activeElement as HTMLElement | null;
          focusAfter.current = active?.dataset.grip ?? active?.dataset.move ?? null;
          setDraft(next);
        }
      }
      if (what === 'size' && size) setDraft(draft.map((it, j) => (j === index ? { ...it, size } : it)));
      if (what === 'hide') { setDraft(draft.filter((_, j) => j !== index)); setSaid(`${titleOf(item.id)} taken off.`); }
      return;
    }
    if (what === 'earlier' || what === 'later') {
      const next = moved(answer.layout, index, what === 'earlier' ? index - 1 : index + 1);
      if (next) void save(next, answer);
    }
    if (what === 'size' && size) void save(answer.layout.map((it, j) => (j === index ? { ...it, size } : it)), answer);
    if (what === 'hide') {
      void save(answer.layout.filter((_, j) => j !== index), answer).then((ok) => { if (ok) setUndo({ item, at: index }); });
    }
  };

  const putBack = (): void => {
    if (!undo) return;
    const next = answer.layout.filter((it) => it.id !== undo.item.id);
    next.splice(Math.min(undo.at, next.length), 0, undo.item);
    setUndo(null);
    void save(next, answer);
  };

  const done = (): void => {
    setSaving(true);
    void save(draft, answer).then((ok) => {
      setSaving(false);
      if (ok) { setEditing(false); setSaid('Widgets saved.'); }
    });
  };

  const retry = (id: string): void => {
    setRetrying(id);
    void api.refreshWidget(id).then(apply, () => {}).finally(() => setRetrying(null));
  };

  const drag: DragState = {
    dragging,
    over,
    start: (id) => setDragging(id),
    enter: (id) => { if (over !== id) setOver(id); },
    end: () => { setDragging(null); setOver(null); },
    drop: (id) => {
      const from = draft.findIndex((it) => it.id === dragging);
      const to = draft.findIndex((it) => it.id === id);
      const next = from >= 0 && to >= 0 ? moved(draft, from, to) : null;
      if (next) setDraft(next);
      setDragging(null);
      setOver(null);
    },
  };

  const unplaced = answer.available.filter((w) => !layout.some((it) => it.id === w.id));
  const undoSlot = undo ? (
    <div key="undo" className="wg-undo" data-size={undo.item.size} role="status" aria-live="polite">
      <span>{titleOf(undo.item.id)} hidden</span>
      <span className="home-glance-sep" aria-hidden="true">·</span>
      <Button size="sm" variant="ghost" onClick={putBack}>Undo</Button>
    </div>
  ) : null;

  const frames: ReactNode[] = [];
  layout.forEach((item, i) => {
    const info = byId.get(item.id);
    if (!info) return;
    if (undo && !editing && undo.at === i) frames.push(undoSlot);
    frames.push(
      <WidgetFrame
        key={item.id}
        info={info}
        item={item}
        view={answer.widgets[item.id]}
        index={i}
        count={layout.length}
        editing={editing}
        navigate={navigate}
        act={act(i)}
        onRetry={() => retry(item.id)}
        retrying={retrying === item.id}
        drag={drag}
      />,
    );
  });
  if (undo && !editing && undo.at >= layout.length) frames.push(undoSlot);

  const extras = answer.available.length - 2;
  return (
    <section className="ui-section wg-section" aria-label="Widgets">
      <div className="ui-section-head">
        <h3 className="ui-section-title">Widgets</h3>
        {editing ? (
          <div className="ui-toolbar" data-align="end">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft([]); }} disabled={saving}>Cancel</Button>
            <Button size="sm" variant="accent" onClick={done} disabled={saving}>{saving ? 'Saving…' : 'Done'}</Button>
          </div>
        ) : layout.length > 0 ? (
          <div className="ui-toolbar" data-align="end">
            <Button size="sm" variant="ghost" onClick={startEdit}>Edit</Button>
          </div>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">{said}</p>
      {failure ? <Notice tone="critical" role="alert">{failure}</Notice> : null}
      {layout.length === 0 && !editing && !undo ? (
        <div className="wg-empty">
          <div className="wg-empty-text">
            <p className="wg-empty-title">Add widgets to Home</p>
            <p className="wg-empty-sub">
              Small live panels from your plugins:{' '}
              {answer.available.slice(0, 2).map((w) => w.title).join(', ')}
              {extras > 0 ? ` and ${extras} more` : ''}.
            </p>
          </div>
          <Button size="sm" variant="accent" onClick={startEdit}>Add widgets</Button>
        </div>
      ) : frames.length > 0 ? (
        <div className="wg-grid" data-editing={editing ? 'true' : undefined}>{frames}</div>
      ) : null}
      {editing ? (
        <div className="wg-gallery" role="region" aria-label="Add widgets">
          <p className="wg-gallery-title">Add widgets</p>
          {unplaced.length === 0 ? (
            <p className="wg-empty-sub">Every widget your plugins offer is on Home.</p>
          ) : (
            <ul className="wg-gallery-list">
              {unplaced.map((w) => (
                <li key={w.id} className="wg-add">
                  <span className="wg-add-text">
                    <span className="wg-add-title">{w.title}</span>
                    <span className="wg-add-sub">
                      {w.plugin} plugin · {w.sizes.length > 1 ? 'small or medium' : `${w.sizes[0]} only`}
                      {w.sensitive ? ' · hidden until you show it' : ''}
                    </span>
                  </span>
                  <Button size="sm" aria-label={`Add ${w.title}`} onClick={() => { setDraft([...draft, { id: w.id, size: w.sizes[0]! }]); setSaid(`${w.title} added.`); }}>
                    <Icon name="plus" size={12} /> Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
