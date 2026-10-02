/**
 * Settings → Lock screen → What it shows: the lock screen editor (kit:
 * LockScreen.jsx, LockFaceEditor).
 *
 * A live preview — the lock screen's own face, drawn from the same data the
 * lock screen reads, at its real proportions and scaled into its box, on a
 * desk or a phone — beside what shapes it:
 *
 *  - **Clock**: the time (Profile, 12-hour, 24-hour), the date (Profile, three
 *    spellings, or none) and a second clock (a place of the owner's in another
 *    zone, or a town found by name).
 *  - **Widgets**: the lock screen's own placements, up to four, never a
 *    sensitive one — each with its size, its settings, its order and ×; "Add a
 *    widget" offers Home's placements (a copy, with their settings) and every
 *    widget. Each keeps its own settings, apart from Home's.
 *
 * Every change is kept at once, like the rest of the panel, and the preview
 * reads the lock screen again. The focus shows only while one is on: the
 * editor says so rather than inventing one for the preview.
 */
import { useEffect, useRef, useState } from 'react';
import {
  api,
  type FoundPlaceView,
  type LockClock,
  type LockScreenData,
  type WidgetInfo,
  type WidgetPlacement,
  type WidgetSize,
  type WidgetsAnswer,
} from '../api';
import { fmtDate, profileTimeLabel, underFormats } from '../format';
import { LockFace, lockBackgroundOf } from '../shell/LockScreen';
import { useMinute } from '../shell/useMinute';
import { ActionMenu, Button, ErrorBanner, Field, Icon, Section, Segment, useAsync } from '../ui';
import { newPlacementKey } from './parts/HomeWidgets';
import { WidgetSettingsSheet } from './parts/WidgetSettings';

const LOCK_MAX = 4;
const DEFAULT_CLOCK: LockClock = { time: 'profile', date: 'profile', zone: null };

/** The face at its own size: a desk is 1280 × 800, a phone 390 × 780. */
function Preview({ data, phone }: { data: LockScreenData | undefined; phone: boolean }): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const now = useMinute();
  const [scale, setScale] = useState(0.4);
  const width = phone ? 390 : 1280;
  const height = phone ? 780 : 800;
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const fit = (): void => setScale(el.clientWidth / width || 0.4);
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  const owner = data?.owner ?? null;
  return (
    <div ref={box} className="lke-preview" data-phone={phone ? 'true' : undefined} style={{ aspectRatio: `${width} / ${height}` }} role="img" aria-label="Preview of the lock screen">
      <div
        className="lk"
        data-preview="true"
        data-bg={lockBackgroundOf(data?.background, data?.image)}
        data-phone={phone ? 'true' : undefined}
        data-view="glance"
        style={{ width, height, transform: `scale(${scale})` }}
        aria-hidden="true"
      >
        <LockFace data={data ?? null} now={now} phone={phone} />
        <footer className="lk-unlock">
          {phone ? (
            <span className="lk-chip lk-enter"><Icon name="lock" size={14} /><span>Enter PIN</span></span>
          ) : (
            <>
              <div className="lk-who">
                <span className="lk-face">{(owner ?? 'You').slice(0, 1).toUpperCase()}</span>
                {owner ? <span className="lk-owner">{owner}</span> : null}
              </div>
              <span className="lk-pin"><Icon name="lock" size={15} /><span className="lke-pin-hint">Enter your PIN</span></span>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/** One of the lock screen's own placements, as a row. */
function Row({ info, placement, index, count, onSize, onSettings, onMove, onRemove }: {
  info: WidgetInfo;
  placement: WidgetPlacement;
  index: number;
  count: number;
  onSize: (size: WidgetSize) => void;
  onSettings: () => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}): JSX.Element {
  const label = placement.label ?? info.title;
  return (
    <li className="lke-row" data-key={placement.key}>
      <span className="lke-row-text">
        <span className="lke-row-title">{label}</span>
        <span className="lke-row-sub">{info.builtIn ? 'Built in' : `${info.plugin} plugin`}</span>
      </span>
      <span className="lke-row-tools">
        {info.sizes.length > 1 ? (
          <Segment<WidgetSize>
            label={`Size of ${label}`}
            options={(['small', 'medium'] as const).filter((s) => info.sizes.includes(s)).map((s) => ({ value: s, label: s === 'small' ? 'Small' : 'Medium' }))}
            value={placement.size}
            onChange={onSize}
          />
        ) : null}
        <span className="lke-row-acts">
        {(info.settings?.length ?? 0) > 0 ? (
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label={`Settings for ${label}`} title="Settings" onClick={onSettings}><Icon name="settings" size={14} /></button>
        ) : null}
        <span className="lke-move">
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label={`Move ${label} earlier`} title="Move earlier" disabled={index === 0} onClick={() => onMove(-1)}><Icon name="chevron-left" /></button>
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label={`Move ${label} later`} title="Move later" disabled={index === count - 1} onClick={() => onMove(1)}><Icon name="chevron-right" /></button>
        </span>
        <button type="button" className="ui-icon-btn" data-size="sm" aria-label={`Take ${label} off the lock screen`} title="Take off the lock screen" onClick={onRemove}><Icon name="close" size={12} /></button>
        </span>
      </span>
    </li>
  );
}

/** The second clock's choice, as the select names it. */
function zoneValue(zone: LockClock['zone']): string {
  if (!zone) return '';
  return 'place' in zone ? `place:${zone.place}` : `town:${zone.timezone}:${zone.label}`;
}

export function LockFaceEditor({ clock: saved, onClock, version }: {
  clock: LockClock | undefined;
  onClock: (clock: LockClock) => void;
  /** Changes when the panel above saved something the face shows (the background): the preview reads again. */
  version: string;
}): JSX.Element {
  const clock = saved ?? DEFAULT_CLOCK;
  const screen = useAsync(() => api.lockScreen(), [version]);
  const widgets = useAsync(() => api.widgets('lock'), []);
  const owner = useAsync(() => api.owner(), []);
  const [answer, setAnswer] = useState<WidgetsAnswer | undefined>(undefined);
  const [phone, setPhone] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [finding, setFinding] = useState<null | { query: string; found: FoundPlaceView[]; busy: boolean; missed?: string }>(null);
  const [town, setTown] = useState<{ label: string; timezone: string } | null>(null);

  useEffect(() => { if (widgets.data) setAnswer(widgets.data); }, [widgets.data]);

  const timezone = screen.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const placements = answer?.lock ?? [];
  const byId = new Map((answer?.available ?? []).map((w) => [w.id, w]));
  const full = placements.length >= LOCK_MAX;

  const saveWidgets = (next: WidgetPlacement[]): Promise<boolean> => {
    if (!answer) return Promise.resolve(false);
    const previous = answer;
    setFailed(null);
    setAnswer({ ...answer, lock: next, arranged: { ...answer.arranged, lock: true } });
    return api.saveWidgets('lock', next).then(
      (fresh) => { setAnswer(fresh); screen.reload(); return true; },
      (err: unknown) => { setAnswer(previous); setFailed(`Couldn't save the lock screen's widgets: ${err instanceof Error ? err.message : String(err)}`); return false; },
    );
  };
  const move = (index: number, by: -1 | 1): void => {
    const next = placements.slice();
    const [it] = next.splice(index, 1);
    next.splice(index + by, 0, it!);
    void saveWidgets(next);
  };
  const add = (widget: string, settings: Record<string, unknown>): void => {
    const info = byId.get(widget);
    if (!info || full) return;
    void saveWidgets([...placements, { key: newPlacementKey(), widget, size: info.sizes.includes('small') ? 'small' : info.sizes[0]!, settings }]);
  };

  const setZone = (value: string): void => {
    if (value === 'find') { setFinding({ query: '', found: [], busy: false }); return; }
    setFinding(null);
    if (value === '') return onClock({ ...clock, zone: null });
    if (value.startsWith('place:')) return onClock({ ...clock, zone: { place: value.slice(6) } });
    const current = clock.zone && !('place' in clock.zone) ? clock.zone : town;
    if (current) onClock({ ...clock, zone: current });
  };
  const find = (): void => {
    if (!finding || finding.query.trim().length < 2) return;
    const query = finding.query.trim();
    setFinding({ query: finding.query, found: [], busy: true });
    api.findPlace(query).then(({ found }) => {
      const withZone = found.filter((f) => f.timezone);
      if (withZone.length === 0) { setFinding({ query, found: [], busy: false, missed: `Nothing with a timezone found for “${query}”.` }); return; }
      const first = withZone[0]!;
      const picked = { label: first.name.split(',')[0]?.trim() || first.name, timezone: first.timezone! };
      setTown(picked);
      setFinding(null);
      onClock({ ...clock, zone: picked });
    }).catch(() => setFinding({ query, found: [], busy: false, missed: 'The place finder didn’t answer. Try again in a moment.' }));
  };

  // What Profile reads as, so each choice says what it means.
  const now = new Date();
  const dateIn = (format: 'short' | 'long' | 'iso' | null): string => underFormats({ dateFormat: format }, () => fmtDate(now, timezone, { weekday: true }));
  const places = (owner.data?.places ?? []).filter((p) => p.timezone && p.timezone !== timezone);
  const custom = clock.zone && !('place' in clock.zone) ? clock.zone : town;
  const fromHome = (answer?.home ?? []).filter((p) => byId.has(p.widget) && !byId.get(p.widget)!.sensitive);
  const every = (answer?.available ?? []).filter((w) => !w.sensitive);
  const sensitive = (answer?.available ?? []).filter((w) => w.sensitive).map((w) => w.title);
  const open = sheet ? placements.find((p) => p.key === sheet) : undefined;
  const openInfo = open ? byId.get(open.widget) : undefined;

  return (
    <Section title="What it shows" aside="Every change is kept at once." panel>
      <div className="lke">
        <div className="lke-look">
          <Preview data={screen.data} phone={phone} />
          <div className="lke-look-foot">
            <Segment<'desk' | 'phone'>
              label="Preview on"
              options={[{ value: 'desk', label: 'Desk' }, { value: 'phone', label: 'Phone' }]}
              value={phone ? 'phone' : 'desk'}
              onChange={(v) => setPhone(v === 'phone')}
            />
            <span className="lke-look-note">As it shows now{screen.data?.focus ? ', with your focus on' : ''}.</span>
          </div>
        </div>
        <div className="lke-controls">
          <ErrorBanner message={failed} />
          <div className="lke-group" role="group" aria-label="Clock">
            <p className="lke-group-title">Clock</p>
            <div className="wg-field" role="group" aria-label="Time">
              <span className="wg-field-label">Time</span>
              <Segment<LockClock['time']>
                label="Time"
                options={[{ value: 'profile', label: profileTimeLabel() }, { value: '12h', label: '12-hour' }, { value: '24h', label: '24-hour' }]}
                value={clock.time}
                onChange={(time) => onClock({ ...clock, time })}
              />
            </div>
            <Field label="Date">
              <select value={clock.date} onChange={(e) => onClock({ ...clock, date: e.target.value as LockClock['date'] })}>
                <option value="profile">Profile · {dateIn(null)}</option>
                <option value="short">{dateIn('short')}</option>
                <option value="long">{dateIn('long')}</option>
                <option value="iso">{dateIn('iso')}</option>
                <option value="off">No date</option>
              </select>
            </Field>
            <Field label="A second clock" hint="A place in another zone, under the time.">
              <select value={finding ? 'find' : zoneValue(clock.zone)} onChange={(e) => setZone(e.target.value)}>
                <option value="">None</option>
                {places.map((p) => <option key={p.id} value={`place:${p.id}`}>{p.label} — {p.name.split(',')[0]}</option>)}
                {clock.zone && 'place' in clock.zone && !places.some((p) => p.id === (clock.zone as { place: string }).place) ? (
                  <option value={zoneValue(clock.zone)}>A place no longer in another zone</option>
                ) : null}
                {custom ? <option value={`town:${custom.timezone}:${custom.label}`}>{custom.label}</option> : null}
                <option value="find">Another town…</option>
              </select>
            </Field>
            {finding ? (
              <div className="wg-field-stack">
                <div className="wg-find">
                  <input
                    autoFocus
                    value={finding.query}
                    placeholder="Find a town: Tokyo"
                    aria-label="Find a town for the second clock"
                    onChange={(e) => setFinding({ ...finding, query: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } if (e.key === 'Escape') setFinding(null); }}
                  />
                  <Button size="sm" disabled={finding.busy || finding.query.trim().length < 2} onClick={find}>{finding.busy ? 'Finding…' : 'Find'}</Button>
                </div>
                {finding.missed ? <span className="ui-field-hint">{finding.missed}</span> : null}
              </div>
            ) : null}
          </div>

          <div className="lke-group" role="group" aria-label="Widgets">
            <div className="lke-group-head">
              <p className="lke-group-title">Widgets <span className="lke-count">{placements.length} of {LOCK_MAX}</span></p>
              {full || !answer ? (
                <Button size="sm" disabled><Icon name="plus" size={12} /> Add a widget</Button>
              ) : (
                <ActionMenu
                  label="Add a widget"
                  trigger={<button type="button" className="ui-btn" data-size="sm"><Icon name="plus" size={12} /> Add a widget</button>}
                  items={[
                    fromHome.length > 0 ? { heading: 'As on Home' } : null,
                    ...fromHome.map((p) => ({ label: p.label ?? byId.get(p.widget)!.title, hint: 'same settings', onSelect: () => add(p.widget, p.settings) })),
                    fromHome.length > 0 ? 'separator' as const : null,
                    { heading: 'Every widget' },
                    ...every.map((w) => ({ label: w.title, onSelect: () => add(w.id, {}) })),
                  ]}
                />
              )}
            </div>
            {!answer ? (
              <p className="lke-empty" aria-busy="true">Reading the lock screen’s widgets…</p>
            ) : placements.length === 0 ? (
              <p className="lke-empty">No widgets: just the clock and the counts.</p>
            ) : (
              <ul className="lke-list">
                {placements.map((p, i) => {
                  const info = byId.get(p.widget);
                  if (!info) return null;
                  return (
                    <Row
                      key={p.key}
                      info={info}
                      placement={p}
                      index={i}
                      count={placements.length}
                      onSize={(size) => void saveWidgets(placements.map((it) => (it.key === p.key ? { ...it, size } : it)))}
                      onSettings={() => setSheet(p.key)}
                      onMove={(by) => move(i, by)}
                      onRemove={() => void saveWidgets(placements.filter((it) => it.key !== p.key))}
                    />
                  );
                })}
              </ul>
            )}
            <p className="ui-field-hint">
              {full ? 'Four is the most it holds; take one off to add another. ' : ''}
              Each keeps its own settings, apart from Home’s.
              {sensitive.length > 0 ? ` A sensitive widget — ${sensitive.join(', ')} — never shows here.` : ' A sensitive widget never shows here.'}
              {' '}One with nothing to show right now stays off until it has.
            </p>
          </div>
          <p className="lke-note">
            <Icon name="moon" size={13} />
            <span>Your focus shows at the top only while one is on. Approvals and what else needs you show as counts when there are some, never what they say.</span>
          </p>
        </div>
      </div>
      {open && openInfo ? (
        <WidgetSettingsSheet
          info={openInfo}
          placement={open}
          surface="lock"
          onClose={() => setSheet(null)}
          onSave={(settings) => saveWidgets(placements.map((it) => (it.key === open.key ? { ...it, settings } : it))).then((ok) => { if (ok) setSheet(null); return ok; })}
          onRemove={() => { setSheet(null); void saveWidgets(placements.filter((it) => it.key !== open.key)); }}
        />
      ) : null}
    </Section>
  );
}
