/**
 * A placement's settings, in a sheet (kit: Widgets.jsx, WidgetSettingsSheet).
 *
 * The placement is drawn live at its size as the fields change — produced by
 * the gateway with the unsaved settings, through the widget's own cache — then
 * the fields the widget declares, from the fixed vocabulary: select (three
 * short choices as a segment, more as radio rows), multiselect (tick rows; none
 * ticked is all), toggle, text, place (the owner's places as rows, or a town
 * found by name; one, or up to three) and time format (Profile, 12-hour,
 * 24-hour). Remove · Cancel · Save at the foot. Each placement keeps its own:
 * the sheet says so, and on the lock screen that Home keeps its own.
 *
 * Shared by Home's Widgets and the lock screen editor; neither knows a plugin.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type FoundPlaceView,
  type WidgetInfo,
  type WidgetPlacement,
  type WidgetPlaceValue,
  type WidgetSettingField,
  type WidgetSettingOption,
  type WidgetSettingsSheet,
  type WidgetSurface,
  type WidgetView,
} from '../../api';
import { profileTimeLabel } from '../../format';
import { Button, ErrorBanner, Icon, Segment, Sheet, Spacer, Toolbar, useAsync } from '../../ui';
import { WidgetBodyView } from './WidgetBody';

/** Up to this many places in a field that takes several. */
const PLACES_MAX = 3;

/** Radio or tick rows in one bordered list: a choice among a few named things. */
function OptionRows({
  label,
  options,
  multiple,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<WidgetSettingOption & { sub?: string }>;
  multiple?: boolean;
  value: string | string[];
  onChange: (value: string | string[]) => void;
}): JSX.Element {
  const list = Array.isArray(value) ? value : [value];
  const on = (v: string): boolean => list.includes(v);
  const flip = (v: string): void => {
    if (!multiple) return onChange(v);
    onChange(on(v) ? list.filter((x) => x !== v) : [...list, v]);
  };
  return (
    <div className="wg-options" role={multiple ? 'group' : 'radiogroup'} aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role={multiple ? 'checkbox' : 'radio'}
          aria-checked={on(o.value)}
          className="wg-option"
          data-on={on(o.value) ? 'true' : undefined}
          onClick={() => flip(o.value)}
        >
          <span className="wg-option-mark" data-multiple={multiple ? 'true' : undefined} aria-hidden="true">
            {multiple && on(o.value) ? <Icon name="check" size={12} /> : null}
          </span>
          <span className="wg-option-text">
            <span className="wg-option-name">{o.label}</span>
            {o.sub ? <span className="wg-option-sub">{o.sub}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

/** A place value's identity among the rows: the owner's by id, a town by where it is. */
function placeId(value: WidgetPlaceValue): string {
  return 'place' in value ? value.place : `town:${value.latitude.toFixed(3)},${value.longitude.toFixed(3)}`;
}

function townOf(found: FoundPlaceView): WidgetPlaceValue {
  return { label: found.name.split(',')[0]?.trim() || found.name, name: found.name, latitude: found.latitude, longitude: found.longitude, timezone: found.timezone ?? null };
}

/** A place field: the owner's places, any town found by name; one, or up to three. */
function PlaceField({
  field,
  value,
  places,
  onChange,
}: {
  field: Extract<WidgetSettingField, { kind: 'place' }>;
  value: unknown;
  places: WidgetSettingsSheet['places'];
  onChange: (value: WidgetPlaceValue | WidgetPlaceValue[] | null) => void;
}): JSX.Element {
  const chosen: WidgetPlaceValue[] = (Array.isArray(value) ? value : value ? [value] : []) as WidgetPlaceValue[];
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<WidgetPlaceValue[]>([]);
  const [finding, setFinding] = useState(false);
  const [missed, setMissed] = useState<string | null>(null);
  const known = new Map<string, { value: WidgetPlaceValue; label: string; sub: string }>();
  for (const p of places) known.set(p.id, { value: { place: p.id }, label: p.label, sub: p.name });
  for (const v of [...chosen, ...found]) {
    if (!('place' in v)) known.set(placeId(v), { value: v, label: v.label, sub: v.name });
  }
  const rows = [...known.entries()].map(([id, r]) => ({ value: id, label: r.label, sub: r.sub }));
  const ids = chosen.map(placeId);
  // A single place left unset is Home: the row says so rather than looking unchosen.
  const home = places.find((p) => p.id === 'home' || p.label.toLowerCase() === 'home') ?? places[0];
  const shown = field.multiple ? ids : ids[0] ?? home?.id ?? '';
  const pick = (next: string | string[]): void => {
    const list = (Array.isArray(next) ? next : [next]).map((id) => known.get(id)?.value).filter((v): v is WidgetPlaceValue => !!v);
    onChange(field.multiple ? list.slice(-PLACES_MAX) : list[0] ?? null);
  };
  const find = (): void => {
    const q = query.trim();
    if (q.length < 2) return;
    setFinding(true);
    setMissed(null);
    api.findPlace(q).then(({ found: answers }) => {
      const towns = answers.slice(0, 3).map(townOf);
      setFound(towns);
      if (towns.length === 0) setMissed(`Nothing found for “${q}”.`);
      else if (field.multiple) onChange([...chosen, towns[0]!].slice(-PLACES_MAX));
      else onChange(towns[0]!);
    }).catch(() => setMissed('The place finder didn’t answer. Try again in a moment.')).finally(() => setFinding(false));
  };
  return (
    <div className="wg-field-stack">
      {rows.length > 0 ? <OptionRows label={field.label} options={rows} multiple={field.multiple} value={shown} onChange={pick} /> : null}
      <div className="wg-find">
        <input
          value={query}
          placeholder="Find a town: Tokyo"
          aria-label={`Find a town for ${field.label}`}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } }}
        />
        <Button size="sm" disabled={finding || query.trim().length < 2} onClick={find}>{finding ? 'Finding…' : 'Find'}</Button>
      </div>
      {missed ? <span className="ui-field-hint">{missed}</span> : null}
    </div>
  );
}

/** One field, drawn by its kind. */
function SettingField({
  field,
  value,
  sheet,
  onChange,
}: {
  field: WidgetSettingField;
  value: unknown;
  sheet: WidgetSettingsSheet;
  onChange: (value: unknown) => void;
}): JSX.Element {
  let control: ReactNode;
  switch (field.kind) {
    case 'select': {
      const options = field.options ?? [];
      const current = typeof value === 'string' ? value : field.default ?? options[0]?.value ?? '';
      const short = options.length > 0 && options.length <= 3 && options.every((o) => o.label.length <= 14);
      control = options.length === 0
        ? <span className="ui-field-hint">Nothing to choose from yet.</span>
        : short
          ? <Segment label={field.label} options={options} value={current} onChange={onChange} />
          : <OptionRows label={field.label} options={options} value={current} onChange={onChange} />;
      break;
    }
    case 'multiselect': {
      const options = field.options ?? [];
      control = options.length === 0
        ? <span className="ui-field-hint">Nothing to choose from yet.</span>
        : <OptionRows label={field.label} options={options} multiple value={Array.isArray(value) ? (value as string[]) : field.default ?? []} onChange={onChange} />;
      break;
    }
    case 'toggle':
      return (
        <div className="wg-field">
          <label className="wg-toggle">
            <input type="checkbox" checked={typeof value === 'boolean' ? value : field.default ?? false} onChange={(e) => onChange(e.target.checked)} />
            <span>{field.label}</span>
          </label>
          {field.hint ? <span className="ui-field-hint">{field.hint}</span> : null}
        </div>
      );
    case 'text':
      control = (
        <input
          aria-label={field.label}
          value={typeof value === 'string' ? value : field.default ?? ''}
          maxLength={field.max ?? 60}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
      break;
    case 'place':
      control = <PlaceField field={field} value={value} places={sheet.places} onChange={onChange} />;
      break;
    case 'timeFormat':
      control = (
        <Segment
          label={field.label}
          options={[
            // What Profile reads as now, so the choice says what it means.
            { value: 'profile', label: profileTimeLabel() },
            { value: '12h', label: '12-hour' },
            { value: '24h', label: '24-hour' },
          ]}
          value={value === '12h' || value === '24h' ? value : 'profile'}
          onChange={onChange}
        />
      );
      break;
  }
  return (
    <div className="wg-field" role="group" aria-label={field.label}>
      <span className="wg-field-label">{field.label}</span>
      {control}
      {field.hint ? <span className="ui-field-hint">{field.hint}</span> : null}
    </div>
  );
}

/** The live frame at the top of the sheet. */
function Preview({ info, placement, surface, view, label }: { info: WidgetInfo; placement: WidgetPlacement; surface: WidgetSurface; view: WidgetView | null; label: string }): JSX.Element {
  const compact = surface === 'lock';
  const text = view?.body?.kind === 'text';
  const size = compact && (text || placement.size === 'small') ? 'small' : placement.size;
  const inner = !view ? (
    <span className="wg-skel-body" aria-hidden="true"><span className="wg-skel" data-w="half" /><span className="wg-skel" data-w="third" /><span className="wg-push" /><span className="wg-skel" /></span>
  ) : view.body ? (
    info.sensitive ? <span className="wg-state"><span className="wg-mask" aria-hidden="true">••••</span><span className="wg-state-sub">Hidden on this screen.</span></span>
      : <WidgetBodyView body={view.body} size={size} />
  ) : (
    <span className="wg-state"><span className="wg-state-sub">{view.state === 'error' ? `Couldn't load this${view.error ? `: ${view.error}` : ''}.` : 'Nothing to show right now.'}</span></span>
  );
  return (
    <div className="wg-preview" data-surface={surface} aria-label={`Preview of ${label}`} role="img">
      <div className="wg-frame" data-size={size} data-variant={compact ? 'compact' : undefined} data-kind={view?.body && !info.sensitive ? view.body.kind : undefined} aria-hidden="true">
        {compact ? null : <div className="wg-head"><span className="wg-title">{label}</span></div>}
        <div className="wg-body">{inner}</div>
        {compact ? <span className="wg-compact-title">{label}</span> : null}
      </div>
    </div>
  );
}

export function WidgetSettingsSheet({
  info,
  placement,
  surface,
  onSave,
  onRemove,
  onClose,
}: {
  info: WidgetInfo;
  placement: WidgetPlacement;
  surface: WidgetSurface;
  /** Keep these settings; resolves false when the save failed (the sheet stays open). */
  onSave: (settings: Record<string, unknown>) => Promise<boolean>;
  onRemove: () => void;
  onClose: () => void;
}): JSX.Element {
  const sheet = useAsync(() => api.widgetSettings(info.id), [info.id]);
  const [draft, setDraft] = useState<Record<string, unknown>>(placement.settings ?? {});
  const [view, setView] = useState<WidgetView | null>(null);
  const [label, setLabel] = useState(placement.label ?? info.title);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const asked = useRef(0);
  const draftKey = useMemo(() => JSON.stringify(draft), [draft]);

  // The live body: asked a moment after the last change, the latest answer wins.
  useEffect(() => {
    const n = ++asked.current;
    const timer = window.setTimeout(() => {
      api.previewWidget({ widget: info.id, size: placement.size, settings: draft }).then((answer) => {
        if (n !== asked.current) return;
        setView(answer.view);
        setLabel(answer.label);
      }).catch(() => {
        if (n === asked.current) setView({ state: 'error', error: 'the preview could not be made' });
      });
    }, view ? 250 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, info.id, placement.size]);

  const save = (): void => {
    setSaving(true);
    setFailed(null);
    void onSave(draft).then((ok) => {
      setSaving(false);
      if (!ok) setFailed('Couldn’t keep these settings. Try again.');
    });
  };
  const where = surface === 'lock' ? 'the lock screen' : 'Home';
  return (
    <Sheet
      title={label}
      onClose={onClose}
      foot={(
        <Toolbar>
          <Button variant="danger-ghost" onClick={onRemove}>Remove from {surface === 'lock' ? 'lock screen' : 'Home'}</Button>
          <Spacer />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={save} disabled={saving || !sheet.data}>{saving ? 'Saving…' : 'Save'}</Button>
        </Toolbar>
      )}
    >
      <div className="wg-sheet">
        <Preview info={info} placement={placement} surface={surface} view={view} label={label} />
        <p className="wg-sheet-note">
          {info.builtIn ? 'Built in' : `From the ${info.plugin} plugin`} · on {where}. These settings are this one’s own{surface === 'lock' ? '; Home keeps its own' : ''}.
        </p>
        <ErrorBanner message={failed ?? (sheet.error ? 'Couldn’t read this widget’s settings.' : null)} />
        {sheet.data
          ? sheet.data.fields.map((field) => (
            <SettingField key={field.key} field={field} value={draft[field.key]} sheet={sheet.data!} onChange={(v) => setDraft({ ...draft, [field.key]: v })} />
          ))
          : sheet.error ? null : <p className="wg-sheet-note" aria-busy="true">Reading its choices…</p>}
      </div>
    </Sheet>
  );
}
