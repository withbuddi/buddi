/**
 * Home's Widgets section: small live panels the plugins export, in the
 * owner's order and sizes (kit: ui_kits/dashboard/Widgets.jsx).
 *
 * It sits under Needs you: what needs the owner stays first, and when nothing
 * does the widgets are right under the composer. A frame is one **placement**
 * — a widget, its size and its own settings, so the same widget can sit twice
 * ("Weather" and "Weather · Work") — drawn as a Home card: title, a stale
 * mark, a ⋯ menu, around a body from five kinds (stat, list, strip, progress,
 * text) the gateway has already checked and cut to size. Nothing here knows a
 * plugin: glyphs from the pinned set, formatted text.
 *
 * Arranging: the ⋯ menu opens the placement's settings and moves, resizes and
 * hides it at once (a hide leaves "<Title> hidden · Undo" in its place for a
 * few seconds); Edit turns every frame into one that can be dragged by its
 * grip (or moved with the arrow keys on it, or its ‹ › buttons, up and down on
 * a phone), resized, set or taken off, and lists every widget to add — one
 * already here that has settings can be added again, its settings opening at
 * once. Done saves, Cancel puts it back. The lock screen keeps its own pick
 * (Settings → Lock screen), said once under the list.
 */
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { api, type WidgetInfo, type WidgetPlacement, type WidgetSize, type WidgetsAnswer, type WidgetView } from '../../api';
import { fmtRelative, fmtShortRelative } from '../../format';
import { pluginPageHref } from '../../pages/pageLinks';
import { settingsRoute } from '../../routes';
import { ActionMenu, Button, Icon, Notice, useAsync } from '../../ui';
import { GLANCE_UNDO_MS } from './HomeGlances';
import { WidgetBodyView } from './WidgetBody';
import { WidgetSettingsSheet } from './WidgetSettings';

export { WidgetBodyView } from './WidgetBody';

/** How often Home asks again; each widget is produced on its own refresh behind it. */
export const WIDGETS_POLL_MS = 60_000;

/** The built-in World clock: asked again on the minute, so it is never a minute late. */
export const CLOCK_WIDGET = 'buddi.clock';

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

/** A key for a placement made here; the gateway keeps it. */
export function newPlacementKey(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `w-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Ask again a moment after the next minute begins, while `on`. */
export function useOnTheMinute(on: boolean, reload: () => void): void {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    if (!on) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => { latest.current(); arm(); }, 60_000 - (Date.now() % 60_000) + 1_000);
    };
    arm();
    return () => clearTimeout(timer);
  }, [on]);
}

/** The widgets answer, kept current by a poll and by every save. */
export function useWidgets(): {
  answer: WidgetsAnswer | undefined;
  error: string | null;
  apply: (answer: WidgetsAnswer) => void;
  reload: () => void;
} {
  const polled = useAsync(() => api.widgets('home'), [], WIDGETS_POLL_MS);
  const [answer, setAnswer] = useState<WidgetsAnswer | undefined>(undefined);
  useEffect(() => {
    if (polled.data) setAnswer(polled.data);
  }, [polled.data]);
  useEffect(() => {
    if (answer) writeCount(answer.home.length);
  }, [answer]);
  // A digital clock is a figure the gateway writes; analog faces tick on the page and need no new answer.
  useOnTheMinute(answer?.home.some((p) => p.widget === CLOCK_WIDGET && answer.views[p.key]?.body?.kind !== 'clocks') ?? false, polled.reload);
  return { answer, error: polled.error, apply: setAnswer, reload: polled.reload };
}

/** The widget ids on Home now: a glance sharing one stays off the date line. */
export function placedIds(answer: WidgetsAnswer | undefined): ReadonlySet<string> {
  return new Set((answer?.home ?? []).map((p) => p.widget));
}

/* ------------------------------------------------------------------ *
 * The frame
 * ------------------------------------------------------------------ */

type Act = 'earlier' | 'later' | 'size' | 'hide' | 'edit' | 'settings';

interface FrameProps {
  info: WidgetInfo;
  placement: WidgetPlacement;
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
  start: (key: string) => void;
  enter: (key: string) => void;
  drop: (key: string) => void;
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

const labelOf = (placement: WidgetPlacement, info: WidgetInfo | undefined): string => placement.label ?? info?.title ?? placement.widget;

function WidgetFrame({ info, placement, view, index, count, editing, navigate, act, onRetry, retrying, drag }: FrameProps): JSX.Element {
  const [shown, setShown] = useReveal(info.sensitive === true);
  const state = view?.state ?? 'error';
  const masked = info.sensitive === true && !shown;
  const href = info.link ? pluginPageHref(info.link.plugin, info.link.page, info.link.place) : null;
  const linked = href !== null && !editing && state !== 'error' && !masked;
  const other: WidgetSize = placement.size === 'small' ? 'medium' : 'small';
  const label = labelOf(placement, info);
  const key = placement.key;
  const configurable = (info.settings?.length ?? 0) > 0;

  let inner: ReactNode;
  if (!view && editing) {
    // Just added from the gallery, or set differently: produced once the layout is saved.
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
    inner = <WidgetBodyView body={view.body} size={placement.size} />;
  }

  const onDragStart = (event: DragEvent<HTMLDivElement>): void => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
    drag.start(key);
  };

  return (
    <div
      className="wg-frame"
      role="group"
      aria-label={label}
      data-id={info.id}
      data-key={key}
      data-size={placement.size}
      data-kind={view?.body && !masked && state !== 'error' ? view.body.kind : undefined}
      data-state={state === 'ok' ? undefined : state}
      data-linked={linked ? 'true' : undefined}
      data-dragging={drag.dragging === key ? 'true' : undefined}
      data-over={drag.over === key && drag.dragging !== key ? 'true' : undefined}
      draggable={editing ? true : undefined}
      onDragStart={editing ? onDragStart : undefined}
      onDragOver={editing ? (event) => { if (drag.dragging) { event.preventDefault(); drag.enter(key); } } : undefined}
      onDrop={editing ? (event) => { event.preventDefault(); drag.drop(key); } : undefined}
      onDragEnd={editing ? () => drag.end() : undefined}
    >
      <div className="wg-head">
        {editing ? (
          <button
            type="button"
            className="ui-icon-btn wg-grip"
            data-size="sm"
            data-grip={key}
            aria-label={`Move ${label}, position ${index + 1} of ${count}: arrow keys`}
            title="Drag, or use the arrow keys"
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); act('earlier'); }
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); act('later'); }
            }}
          >
            <Icon name="grip" size={14} />
          </button>
        ) : null}
        <span className="wg-title">{label}</span>
        {state === 'stale' ? (
          <span className="wg-stale" title={view?.error ? `Couldn't refresh: ${view.error}.` : undefined}>
            {view?.updatedAt ? `${fmtShortRelative(view.updatedAt)} old` : 'Not current'}
          </span>
        ) : null}
        {editing && configurable ? (
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label={`Settings for ${label}`} title="Settings" onClick={() => act('settings')}>
            <Icon name="settings" size={14} />
          </button>
        ) : null}
        {editing ? (
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label={`Take ${label} off Home`} title="Take off Home" onClick={() => act('hide')}>
            <Icon name="close" size={12} />
          </button>
        ) : (
          <span className="wg-more">
            <ActionMenu
              label={`More for ${label}`}
              note={view?.updatedAt ? `${info.builtIn ? 'Built in' : info.plugin} · ${fmtRelative(view.updatedAt)}` : info.builtIn ? 'Built in' : info.plugin}
              items={[
                configurable ? { label: 'Settings…', onSelect: () => act('settings') } : null,
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
            <span className="ui-segment" role="radiogroup" aria-label={`Size of ${label}`}>
              {(['small', 'medium'] as const).filter((s) => info.sizes.includes(s)).map((s) => (
                <button key={s} type="button" className="ui-tab" role="radio" aria-checked={placement.size === s} onClick={() => act('size', s)}>
                  {s === 'small' ? 'Small' : 'Medium'}
                </button>
              ))}
            </span>
          ) : (
            <span className="wg-edit-note">{info.sizes[0] === 'small' ? 'Small only' : 'Medium only'}</span>
          )}
          <span className="wg-edit-move">
            <button type="button" className="ui-icon-btn" data-size="sm" data-move={`${key}:earlier`} aria-label={`Move ${label} earlier`} title="Move earlier" disabled={index === 0} onClick={() => act('earlier')}>
              <Icon name="chevron-left" />
            </button>
            <button type="button" className="ui-icon-btn" data-size="sm" data-move={`${key}:later`} aria-label={`Move ${label} later`} title="Move later" disabled={index === count - 1} onClick={() => act('later')}>
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
  const [draft, setDraft] = useState<WidgetPlacement[]>([]);
  const [undo, setUndo] = useState<{ item: WidgetPlacement; at: number } | null>(null);
  const [said, setSaid] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  /** Placements set differently in Edit: drawn as "Fills in when you press Done". */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
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

  // Nothing any plugin offers but the clock: no section, no advert for an empty feature.
  if (answer.available.every((w) => w.builtIn) && answer.home.length === 0) return null;

  const byId = new Map(answer.available.map((w) => [w.id, w]));
  const layout = editing ? draft : answer.home;
  const titleOf = (p: WidgetPlacement): string => labelOf(p, byId.get(p.widget));

  /** Save Home's placements: drawn at once, put back if the save fails. */
  const save = (next: WidgetPlacement[], previous: WidgetsAnswer): Promise<boolean> => {
    setFailure(null);
    apply({ ...previous, home: next, arranged: { ...previous.arranged, home: true } });
    return api.saveWidgets('home', next).then(
      (saved) => { apply(saved); return true; },
      (err: unknown) => {
        apply(previous);
        setFailure(`Couldn't save your widgets: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      },
    );
  };

  const moved = (list: WidgetPlacement[], from: number, to: number): WidgetPlacement[] | null => {
    if (to < 0 || to >= list.length || from === to) return null;
    const next = list.slice();
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it!);
    setSaid(`${titleOf(it!)}, position ${to + 1} of ${next.length}.`);
    return next;
  };

  const startEdit = (): void => {
    setDraft(answer.home);
    setTouched(new Set());
    setUndo(null);
    setFailure(null);
    setEditing(true);
  };

  const act = (index: number) => (what: Act, size?: WidgetSize): void => {
    const item = layout[index]!;
    if (what === 'edit') { startEdit(); return; }
    if (what === 'settings') { setSheet(item.key); return; }
    if (editing) {
      if (what === 'earlier' || what === 'later') {
        const next = moved(draft, index, what === 'earlier' ? index - 1 : index + 1);
        if (next) {
          const active = document.activeElement as HTMLElement | null;
          focusAfter.current = active?.dataset.grip ?? active?.dataset.move ?? null;
          setDraft(next);
        }
      }
      if (what === 'size' && size) { setDraft(draft.map((it, j) => (j === index ? { ...it, size } : it))); setTouched(new Set([...touched, item.key])); }
      if (what === 'hide') { setDraft(draft.filter((_, j) => j !== index)); setSaid(`${titleOf(item)} taken off.`); }
      return;
    }
    if (what === 'earlier' || what === 'later') {
      const next = moved(answer.home, index, what === 'earlier' ? index - 1 : index + 1);
      if (next) void save(next, answer);
    }
    if (what === 'size' && size) void save(answer.home.map((it, j) => (j === index ? { ...it, size } : it)), answer);
    if (what === 'hide') {
      void save(answer.home.filter((_, j) => j !== index), answer).then((ok) => { if (ok) setUndo({ item, at: index }); });
    }
  };

  const putBack = (): void => {
    if (!undo) return;
    const next = answer.home.filter((it) => it.key !== undo.item.key);
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

  const retry = (key: string): void => {
    setRetrying(key);
    void api.refreshWidget(key).then(apply, () => {}).finally(() => setRetrying(null));
  };

  const add = (w: WidgetInfo): void => {
    const placement: WidgetPlacement = { key: newPlacementKey(), widget: w.id, size: w.sizes[0]!, settings: {} };
    const again = draft.some((it) => it.widget === w.id);
    setDraft([...draft, placement]);
    setSaid(`${w.title} added.`);
    // A second one of the same widget is only useful set differently: its settings open at once.
    if (again && (w.settings?.length ?? 0) > 0) setSheet(placement.key);
  };

  /** The sheet's Save: in Edit it changes the draft, otherwise it is kept at once. */
  const saveSettings = (key: string, settings: Record<string, unknown>): Promise<boolean> => {
    if (editing) {
      setDraft(draft.map((it) => {
        if (it.key !== key) return it;
        const { label: _named, ...rest } = it;
        return { ...rest, settings };
      }));
      setTouched(new Set([...touched, key]));
      setSheet(null);
      return Promise.resolve(true);
    }
    return save(answer.home.map((it) => (it.key === key ? { ...it, settings } : it)), answer).then((ok) => {
      if (ok) { setSheet(null); setSaid('Settings saved.'); }
      return ok;
    });
  };

  const removeFromSheet = (key: string): void => {
    setSheet(null);
    const index = layout.findIndex((it) => it.key === key);
    if (index >= 0) act(index)('hide');
  };

  const drag: DragState = {
    dragging,
    over,
    start: (key) => setDragging(key),
    enter: (key) => { if (over !== key) setOver(key); },
    end: () => { setDragging(null); setOver(null); },
    drop: (key) => {
      const from = draft.findIndex((it) => it.key === dragging);
      const to = draft.findIndex((it) => it.key === key);
      const next = from >= 0 && to >= 0 ? moved(draft, from, to) : null;
      if (next) setDraft(next);
      setDragging(null);
      setOver(null);
    },
  };

  const undoSlot = undo ? (
    <div key="undo" className="wg-undo" data-size={undo.item.size} role="status" aria-live="polite">
      <span>{titleOf(undo.item)} hidden</span>
      <span className="home-glance-sep" aria-hidden="true">·</span>
      <Button size="sm" variant="ghost" onClick={putBack}>Undo</Button>
    </div>
  ) : null;

  const frames: ReactNode[] = [];
  layout.forEach((placement, i) => {
    const info = byId.get(placement.widget);
    if (!info) return;
    if (undo && !editing && undo.at === i) frames.push(undoSlot);
    const fresh = editing && (touched.has(placement.key) || !answer.home.some((it) => it.key === placement.key));
    frames.push(
      <WidgetFrame
        key={placement.key}
        info={info}
        placement={placement}
        view={fresh ? undefined : answer.views[placement.key]}
        index={i}
        count={layout.length}
        editing={editing}
        navigate={navigate}
        act={act(i)}
        onRetry={() => retry(placement.key)}
        retrying={retrying === placement.key}
        drag={drag}
      />,
    );
  });
  if (undo && !editing && undo.at >= layout.length) frames.push(undoSlot);

  const offered = answer.available.filter((w) => !w.builtIn);
  const extras = offered.length - 2;
  const open = sheet ? layout.find((it) => it.key === sheet) : undefined;
  const openInfo = open ? byId.get(open.widget) : undefined;
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
              {(offered.length > 0 ? offered : answer.available).slice(0, 2).map((w) => w.title).join(', ')}
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
          <div className="wg-gallery-head">
            <p className="wg-gallery-title">Add widgets</p>
            <a className="wg-gallery-aside" href={settingsRoute('lock')} onClick={(event) => { event.preventDefault(); navigate(settingsRoute('lock')); }}>
              The lock screen has its own pick
            </a>
          </div>
          <ul className="wg-gallery-list">
            {answer.available.map((w) => {
              const here = draft.filter((it) => it.widget === w.id).length;
              const configurable = (w.settings?.length ?? 0) > 0;
              const origin = w.builtIn ? 'Built in' : `${w.plugin} plugin`;
              const sizes = w.sizes.length > 1 ? 'small or medium' : `${w.sizes[0]} only`;
              const count = here > 1 ? ` · ${here} on Home` : here === 1 && configurable ? ' · on Home' : '';
              return (
                <li key={w.id} className="wg-add">
                  <span className="wg-add-text">
                    <span className="wg-add-title">{w.title}</span>
                    <span className="wg-add-sub">{origin} · {sizes}{w.sensitive ? ' · hidden until you show it' : ''}{count}</span>
                  </span>
                  {/* Without settings a second one would only repeat the first. */}
                  {here > 0 && !configurable ? (
                    <span className="wg-add-note">On Home</span>
                  ) : (
                    <Button size="sm" aria-label={`${here > 0 ? 'Add another' : 'Add'} ${w.title}`} onClick={() => add(w)}>
                      <Icon name="plus" size={12} /> {here > 0 ? 'Add another' : 'Add'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {open && openInfo ? (
        <WidgetSettingsSheet
          info={openInfo}
          placement={open}
          surface="home"
          onClose={() => setSheet(null)}
          onSave={(settings) => saveSettings(open.key, settings)}
          onRemove={() => removeFromSheet(open.key)}
        />
      ) : null}
    </section>
  );
}
