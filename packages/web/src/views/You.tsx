/**
 * You: who the agents are talking to, how they read the time, and where
 * their places are.
 *
 * The profile is one row in the database, read into every agent's prompt —
 * the same row the first-run interview fills and an agent updates when you
 * tell it "call me Sam". Time and Dates decide how every date and time on the
 * dashboard reads (format.ts) and how agents write them. Places (Home, Work
 * and any other) are their own panel, each saved in its sheet: the front desk
 * is told them, and plugins that declare `owner:places` may read them.
 * Nothing here is a permission — it is how to address a person.
 */
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, type FoundPlaceView, type OwnerPlaceView, type OwnerView } from '../api';
import { FORMATS_CHANGED, fmtClock, fmtDate, setDisplayFormats, underFormats } from '../format';
import {
  Button,
  ErrorBanner,
  Field,
  FormGrid,
  Icon,
  List,
  ListRow,
  Notice,
  PageFrame,
  Pill,
  Section,
  Sheet,
  Spacer,
  Stack,
  Toolbar,
  useAsync,
} from '../ui';

export function You({ embedded }: { embedded?: boolean }): JSX.Element {
  const { data, error, reload } = useAsync(() => api.owner(), []);
  return (
    <PageFrame embedded={embedded} title="You" lede="What every agent knows about the person it is talking to.">
      <ErrorBanner message={error} />
      {data ? (
        <Stack gap="lg">
          <Form initial={data} onSaved={reload} />
          <Places initial={data} />
        </Stack>
      ) : null}
    </PageFrame>
  );
}

type TimeChoice = '' | '12h' | '24h';
type DateChoice = '' | 'short' | 'long' | 'iso';

/** 14:05 on a Thursday, the example every option is drawn with. */
const EXAMPLE = new Date(Date.UTC(2026, 9, 1, 14, 5));

function timeOptions(): Array<[TimeChoice, string]> {
  const auto = underFormats({ timeFormat: null }, () => fmtClock(EXAMPLE, 'UTC'));
  return [['', `Auto (${auto} here)`], ['12h', '12-hour · 2:05 PM'], ['24h', '24-hour · 14:05']];
}

function dateOptions(): Array<[DateChoice, string]> {
  const auto = underFormats({ dateFormat: null }, () => fmtDate(EXAMPLE, 'UTC', { weekday: true }));
  return [['', `Auto (${auto} here)`], ['short', 'Thu, Oct 1'], ['long', 'Thursday, 1 October'], ['iso', '2026-10-01']];
}

function Form({ initial, onSaved }: { initial: OwnerView; onSaved: () => void }): JSX.Element {
  const [name, setName] = useState(initial.preferredName ?? '');
  const [zone, setZone] = useState(initial.timezone ?? '');
  const [time, setTime] = useState<TimeChoice>(initial.timeFormat ?? '');
  const [date, setDate] = useState<DateChoice>(initial.dateFormat ?? '');
  const [language, setLanguage] = useState(initial.language ?? '');
  const [about, setAbout] = useState(initial.about ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setName(initial.preferredName ?? '');
    setZone(initial.timezone ?? '');
    setTime(initial.timeFormat ?? '');
    setDate(initial.dateFormat ?? '');
    setLanguage(initial.language ?? '');
    setAbout(initial.about ?? '');
  }, [initial]);

  const dirty =
    name.trim() !== (initial.preferredName ?? '') ||
    zone !== (initial.timezone ?? '') ||
    time !== (initial.timeFormat ?? '') ||
    date !== (initial.dateFormat ?? '') ||
    language.trim() !== (initial.language ?? '') ||
    about.trim() !== (initial.about ?? '');

  const save = async (): Promise<void> => {
    setSaving(true);
    setProblem(null);
    try {
      const answer = await api.setOwner({
        preferredName: name.trim() === '' ? null : name.trim(),
        timezone: zone === '' ? null : zone,
        timeFormat: time === '' ? null : time,
        dateFormat: date === '' ? null : date,
        language: language.trim() === '' ? null : language.trim(),
        about: about.trim() === '' ? null : about.trim(),
      });
      // Every date and time on the open pages reads the new way at once.
      setDisplayFormats({ timeFormat: answer.timeFormat ?? null, dateFormat: answer.dateFormat ?? null });
      window.dispatchEvent(new Event(FORMATS_CHANGED));
      setSaved(true);
      onSaved();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const zones = initial.zones.length > 0 ? initial.zones : [initial.detectedTimezone];
  const touched = <T,>(set: (value: T) => void) => (value: T): void => {
    setSaved(false);
    set(value);
  };
  return (
    <Section
      title="Your profile"
      aside="read by every agent, as context"
      panel
      foot={
        <>
          {saved && !dirty ? <span className="muted">Saved</span> : null}
          <Button variant="accent" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <Stack divided gap="lg">
        <Section title="Name, time and language">
          <FormGrid>
            <Field label="What the agents call you">
              <input value={name} maxLength={80} placeholder={initial.displayName ?? 'Your name'} onChange={(e) => touched(setName)(e.target.value)} />
            </Field>
            <Field label="Timezone" hint={`This host is in ${initial.detectedTimezone}. Existing schedules keep the zone they were made in.`}>
              <select value={zone} onChange={(e) => touched(setZone)(e.target.value)}>
                <option value="">Not set (use the host's)</option>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </Field>
            <Field label="Time">
              <select value={time} onChange={(e) => touched(setTime)(e.target.value as TimeChoice)}>
                {timeOptions().map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Dates" hint="Auto follows this browser's language. Agents write them your way too.">
              <select value={date} onChange={(e) => touched(setDate)(e.target.value as DateChoice)}>
                {dateOptions().map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Answer me in" hint="A language, as you would say it. Blank mirrors whatever you write in.">
              <input value={language} maxLength={40} placeholder="English, français…" onChange={(e) => touched(setLanguage)(e.target.value)} />
            </Field>
          </FormGrid>
        </Section>
        <Section title="About you">
          <Field label="In your own words" hint="Who you are, how you like answers, anything every agent should keep in mind. A few lines is plenty.">
            <textarea
              rows={4}
              maxLength={1000}
              value={about}
              placeholder="I run a small studio and prefer short answers with the numbers first. Call me by my first name."
              onChange={(e) => touched(setAbout)(e.target.value)}
            />
          </Field>
          {problem ? <Notice tone="critical">{problem}</Notice> : null}
        </Section>
      </Stack>
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * Places
 * ------------------------------------------------------------------ */

const SUGGESTED = ['Home', 'Work'] as const;

function placeIcon(label: string): 'home' | 'briefcase' | 'pin' {
  const lower = label.trim().toLowerCase();
  return lower === 'home' ? 'home' : lower === 'work' ? 'briefcase' : 'pin';
}

function PlaceGlyph({ label, empty }: { label: string; empty?: boolean }): JSX.Element {
  return (
    <span className="place-glyph" data-empty={empty ? 'true' : undefined} aria-hidden="true">
      <Icon name={placeIcon(label)} size={18} />
    </span>
  );
}

/** The row's line: the address as typed, then the country it was found in. */
function placeLine(place: OwnerPlaceView): string {
  const country = place.name.split(',').pop()?.trim() ?? '';
  if (!place.address) return place.name;
  return country && !place.address.toLowerCase().includes(country.toLowerCase()) ? `${place.address} · ${country}` : place.address;
}

/** What is being edited: a saved place, or a new one (a suggested label, or none). */
type Editing = { place?: OwnerPlaceView; label: string };

function Places({ initial }: { initial: OwnerView }): JSX.Element {
  const [places, setPlaces] = useState<OwnerPlaceView[]>(initial.places ?? []);
  useEffect(() => setPlaces(initial.places ?? []), [initial]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const ownZone = initial.timezone ?? initial.detectedTimezone;
  const missing = SUGGESTED.filter((label) => !places.some((p) => p.label.toLowerCase() === label.toLowerCase()));
  const now = useMemo(() => new Date(), [places]);
  return (
    <Section
      title="Places"
      aside="the front desk, and plugins you allow"
      actions={<Button size="sm" onClick={() => setEditing({ label: '' })}>Add a place</Button>}
      panel
      flush
    >
      <List>
        {places.map((place) => (
          <ListRow
            key={place.id}
            label={`${place.label}: edit`}
            onClick={() => setEditing({ place, label: place.label })}
            lead={<PlaceGlyph label={place.label} />}
            title={place.label}
            sub={placeLine(place)}
            side={place.timezone && place.timezone !== ownZone ? <Pill>{fmtClock(now, place.timezone)} there</Pill> : undefined}
          />
        ))}
        {missing.map((label) => (
          <ListRow
            key={label}
            label={`${label}: add`}
            onClick={() => setEditing({ label })}
            lead={<PlaceGlyph label={label} empty />}
            title={<span className="muted">{label}</span>}
            sub="Not set"
            side={
              <Button
                size="sm"
                onClick={(event) => {
                  event.stopPropagation(); // the row underneath opens the same sheet
                  setEditing({ label });
                }}
              >
                Add
              </Button>
            }
          />
        ))}
      </List>
      <p className="place-note">Only the town is looked up, on Open-Meteo, to find where it is and its timezone. The address stays on this computer.</p>
      {editing ? (
        <PlaceSheet
          key={editing.place?.id ?? `new:${editing.label}`}
          editing={editing}
          zones={initial.zones.length > 0 ? initial.zones : [initial.detectedTimezone]}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            setPlaces(next);
            setEditing(null);
          }}
        />
      ) : null}
    </Section>
  );
}

function PlaceSheet({
  editing,
  zones,
  onClose,
  onSaved,
}: {
  editing: Editing;
  zones: string[];
  onClose: () => void;
  onSaved: (places: OwnerPlaceView[]) => void;
}): JSX.Element {
  const saved = editing.place;
  const [label, setLabel] = useState(editing.label);
  const [address, setAddress] = useState(saved?.address ?? '');
  const [found, setFound] = useState<FoundPlaceView[] | null>(
    saved ? [{ name: saved.name, latitude: saved.latitude, longitude: saved.longitude, ...(saved.timezone ? { timezone: saved.timezone } : {}) }] : null,
  );
  const [pick, setPick] = useState(0);
  const [zone, setZone] = useState(saved?.timezone ?? '');
  const [busy, setBusy] = useState<'find' | 'save' | 'remove' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [foundFor, setFoundFor] = useState(saved?.address ?? '');
  const chosen = found?.[pick];

  const find = (): void => {
    if (address.trim().length < 2) return;
    setBusy('find');
    setProblem(null);
    api
      .findPlace(address.trim())
      .then((answer) => {
        setFound(answer.found);
        setFoundFor(address.trim());
        setPick(0);
        setZone(answer.found[0]?.timezone ?? '');
        if (answer.found.length === 0) setProblem('Nothing found by that name. Try the town, with its country.');
      })
      .catch((err: unknown) => setProblem(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(null));
  };
  const save = (): void => {
    if (!chosen) return;
    setBusy('save');
    setProblem(null);
    api
      .savePlace({
        ...(saved ? { id: saved.id } : {}),
        label: label.trim(),
        address: address.trim() === '' ? null : address.trim(),
        name: chosen.name,
        latitude: chosen.latitude,
        longitude: chosen.longitude,
        timezone: zone === '' ? null : zone,
      })
      .then((answer) => onSaved(answer.places))
      .catch((err: unknown) => setProblem(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(null));
  };
  const remove = (): void => {
    if (!saved) return;
    setBusy('remove');
    setProblem(null);
    api
      .removePlace(saved.id)
      .then((answer) => onSaved(answer.places))
      .catch((err: unknown) => setProblem(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  const title = saved ? saved.label : editing.label ? `Add ${editing.label}` : 'Add a place';
  const zoneList = zone !== '' && !zones.includes(zone) ? [zone, ...zones] : zones;
  return (
    <Sheet
      title={title}
      onClose={onClose}
      foot={
        <Toolbar>
          {saved ? (
            <Button variant="danger-ghost" disabled={busy !== null} onClick={remove}>{busy === 'remove' ? 'Removing…' : 'Remove'}</Button>
          ) : null}
          <Spacer />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!chosen || label.trim() === '' || busy !== null} onClick={save}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
        </Toolbar>
      }
    >
      <Stack gap="lg">
        <Field label="Name" hint="What you call it: Home, Work, Mum's.">
          <input value={label} maxLength={40} autoFocus={!editing.label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field
          label="Address"
          hint="A street address, or just the town."
          action={<Button disabled={address.trim().length < 2 || busy !== null} onClick={find}>{busy === 'find' ? 'Finding…' : 'Find'}</Button>}
        >
          <input
            value={address}
            maxLength={200}
            autoFocus={Boolean(editing.label) && !saved}
            placeholder="12 Elm Street, Portland, Maine"
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                find();
              }
            }}
          />
        </Field>
        {found && found.length > 0 ? (
          <div className="place-found" role="radiogroup" aria-label="Which place">
            {found.map((option, i) => (
              <button
                key={`${option.latitude},${option.longitude}`}
                type="button"
                role="radio"
                aria-checked={i === pick}
                className="place-option"
                data-on={i === pick ? 'true' : undefined}
                onClick={() => {
                  setPick(i);
                  setZone(option.timezone ?? '');
                }}
              >
                <span className="place-radio" aria-hidden="true" />
                <span className="place-option-text">
                  <span className="place-option-name">{option.name}</span>
                  <span className="place-option-sub">
                    {option.latitude.toFixed(2)}, {option.longitude.toFixed(2)}
                    {option.timezone ? ` · ${option.timezone}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="place-note-inline">Find it to pin it on the map; nothing is saved until you say Save.</p>
        )}
        {saved && found && address.trim() !== foundFor ? (
          <p className="place-note-inline">The address changed. Find it again to move the pin, or save to keep it where it is.</p>
        ) : null}
        <Field label="Its timezone" hint={chosen ? 'From where it is. Change it if that is wrong.' : 'Filled in once the place is found.'}>
          <select value={zone} disabled={!chosen} onChange={(e) => setZone(e.target.value)}>
            <option value="">Not known</option>
            {zoneList.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </Field>
        <ErrorBanner message={problem} />
      </Stack>
    </Sheet>
  );
}
