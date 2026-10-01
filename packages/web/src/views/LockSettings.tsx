/**
 * Settings → Lock screen (docs/dashboard.md, "Lock screen"; the kit's
 * `LockSettings`): the honest sentence, the PIN (set, change, remove — each
 * in a small dialog), how long before it locks and the background; then What
 * it shows (`LockFaceEditor`): a live preview beside the clock's options and
 * the lock screen's own widgets. Kept by the installation, so every device
 * signed in to this dashboard gets the same.
 */
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, api, type LockBackground, type LockState } from '../api';
import { LockFaceEditor } from './LockFaceEditor';
import { useLock } from '../shell/lock';
import { Button, ErrorBanner, Field, Icon, Modal, Notice, Section, Segment, Stack, Toolbar, useAsync } from '../ui';

const BACKGROUNDS: ReadonlyArray<{ id: Exclude<LockBackground, 'image'>; label: string }> = [
  { id: 'field', label: 'Buddi' },
  { id: 'dawn', label: 'Dawn' },
  { id: 'sea', label: 'Sea' },
  { id: 'moss', label: 'Moss' },
  { id: 'dusk', label: 'Dusk' },
];

const DELAYS = [
  { value: '1', label: '1 min' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '60', label: '1 hour' },
  { value: 'never', label: 'Never' },
] as const;
type DelayChoice = (typeof DELAYS)[number]['value'];

const delayOf = (state: LockState): DelayChoice => (state.delayMinutes === null ? 'never' : (String(state.delayMinutes) as DelayChoice));

type DialogKind = 'set' | 'change' | 'remove';

function failure(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.detail ?? {}) as { triesLeft?: number; waitUntil?: string | null };
    if (err.status === 429 || detail.waitUntil) return 'Too many wrong tries. Wait a moment, then try again.';
    if (err.status === 403 && typeof detail.triesLeft === 'number') return `${err.message} ${detail.triesLeft} ${detail.triesLeft === 1 ? 'try' : 'tries'} left.`;
    return err.message;
  }
  return 'Something went wrong. Try again.';
}

/** Set, change or remove the PIN. The server checks the current one and counts the tries. */
function PinDialog({ kind, onClose, onDone }: { kind: DialogKind; onClose: () => void; onDone: (state: LockState) => void }): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const remove = kind === 'remove';
  const needsCurrent = kind !== 'set';
  const ready = !busy && (!needsCurrent || current.length >= 4) && (remove || (next.length >= 4 && again.length >= 4));
  const digits = (v: string): string => v.replace(/\D/g, '').slice(0, 8);
  const title = kind === 'set' ? 'Set a PIN' : kind === 'change' ? 'Change your PIN' : 'Remove the PIN?';

  const save = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!ready) return;
    if (!remove && next !== again) {
      setError('The two PINs aren’t the same.');
      return;
    }
    setBusy(true);
    setError(null);
    const call = remove ? api.removePin(current) : api.setPin(next, needsCurrent ? current : undefined);
    call.then(onDone).catch((err: unknown) => {
      setBusy(false);
      setError(failure(err));
    });
  };

  const pinField = (label: string, value: string, set: (v: string) => void, autoFocus: boolean): JSX.Element => (
    <Field label={label}>
      <input
        type="password"
        inputMode="numeric"
        autoComplete={label === 'Current PIN' ? 'current-password' : 'new-password'}
        maxLength={8}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => { setError(null); set(digits(e.target.value)); }}
      />
    </Field>
  );

  return (
    <Modal
      title={title}
      onClose={onClose}
      foot={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={remove ? 'danger' : 'accent'} disabled={!ready} onClick={() => save()}>
            {remove ? 'Remove PIN' : kind === 'set' ? 'Set PIN' : 'Change PIN'}
          </Button>
        </>
      )}
    >
      <form className="lk-form" onSubmit={save}>
        <p className="lk-honest">{remove
          ? 'The dashboard stops locking, on every device. You can set a PIN again any time.'
          : 'Four to eight digits. You type it to open the dashboard after it locks, on any device signed in to it.'}</p>
        {needsCurrent ? pinField('Current PIN', current, setCurrent, true) : null}
        {remove ? null : pinField(kind === 'set' ? 'PIN' : 'New PIN', next, setNext, !needsCurrent)}
        {remove ? null : pinField('The same again', again, setAgain, false)}
        {error ? <Notice tone="critical">{error}</Notice> : null}
        {/* Enter submits from any field. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

export function LockSettings(_props: { navigate: (route: string) => void }): JSX.Element {
  const lock = useLock();
  const read = useAsync(() => api.lockState(), []);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const state = read.data ?? lock.state;

  const take = (next: LockState): void => {
    lock.update(next);
    read.reload();
  };
  const change = (call: Promise<LockState>): void => {
    setFailed(null);
    call.then(take).catch((err: unknown) => setFailed(failure(err)));
  };
  const upload = (picked: File | undefined): void => {
    if (!picked) return;
    setUploading(true);
    setFailed(null);
    api.uploadLockBackground(picked).then(take).catch((err: unknown) => setFailed(failure(err))).finally(() => {
      setUploading(false);
      if (file.current) file.current.value = '';
    });
  };

  if (!state) {
    return <Section title="Lock screen" panel><ErrorBanner message={read.error ? 'Couldn’t read the lock screen’s settings.' : null} /></Section>;
  }
  const pin = state.pin;
  const swatch = (id: LockBackground, label: string): JSX.Element => (
    <button
      key={id}
      type="button"
      className="lk-swatch"
      data-bg={id}
      aria-pressed={state.background === id}
      aria-label={label}
      title={label}
      onClick={() => change(api.setLockSettings({ background: id }))}
    >
      {id === 'image' && state.image ? <img src={state.image} alt="" /> : <span className="lk-swatch-field" />}
      <span className="lk-swatch-label">{label}</span>
    </button>
  );

  return (
    <>
    <Section
      title="Lock screen"
      aside="Kept for every device signed in to this dashboard."
      actions={pin ? <Button size="sm" onClick={() => lock.lockNow()}><Icon name="lock" size={13} /> Lock now</Button> : undefined}
      panel
    >
      <Stack divided gap="lg">
        <p className="lk-honest ui-section">A privacy screen over this dashboard, on every device signed in to it: it locks when nobody has used it for a while, or when you lock it, and opens with your PIN. A new browser opens locked too. It isn’t a second sign-in — anyone who can run buddi on this computer can open it without the PIN. Telegram and buddi in your coding tools carry on as before.</p>
        <ErrorBanner message={failed} />
        <div className="lk-pref ui-section">
          <div className="lk-pref-text">
            <div className="lk-pref-label">PIN</div>
            <div className="ui-field-hint">{pin ? 'Set. Kept hashed on this buddi; five wrong tries, then a wait that grows.' : 'Four to eight digits. Until you set one, nothing locks.'}</div>
          </div>
          {pin ? (
            <Toolbar>
              <Button size="sm" variant="ghost" onClick={() => setDialog('remove')}>Remove…</Button>
              <Button size="sm" onClick={() => setDialog('change')}>Change…</Button>
            </Toolbar>
          ) : (
            <Button size="sm" variant="accent" onClick={() => setDialog('set')}>Set a PIN</Button>
          )}
        </div>
        <div className="lk-pref ui-section" data-off={pin ? undefined : 'true'} aria-disabled={pin ? undefined : 'true'}>
          <div className="lk-pref-text">
            <div className="lk-pref-label">Lock after</div>
            <div className="ui-field-hint">
              {pin ? <>Nobody using it for this long. Lock it yourself from your menu<span className="lk-shortcut">, or with <kbd className="lk-kbd">{lock.shortcut}</kbd></span>.</> : 'Set a PIN first.'}
            </div>
          </div>
          <Segment<DelayChoice>
            label="Lock after"
            options={DELAYS}
            value={pin ? delayOf(state) : ('' as DelayChoice)}
            onChange={(value) => { if (pin) change(api.setLockSettings({ delayMinutes: value === 'never' ? null : (Number(value) as 1 | 5 | 15 | 60) })); }}
          />
        </div>
        <div className="lk-pref ui-section" data-stack="true">
          <div className="lk-pref-text">
            <div className="lk-pref-label">Background</div>
            <div className="ui-field-hint">Behind the time and your widgets, on every device. A picture is kept as a JPEG of at most 2560 pixels, without its location or other details.</div>
          </div>
          <div className="lk-swatches" role="group" aria-label="Background">
            {BACKGROUNDS.map((b) => swatch(b.id, b.label))}
            {state.image ? swatch('image', 'Your picture') : null}
            <label className="lk-swatch" data-kind="add" aria-busy={uploading ? 'true' : undefined}>
              <input ref={file} type="file" accept="image/jpeg,image/png" className="lk-sr" disabled={uploading} onChange={(e) => upload(e.target.files?.[0])} />
              <span className="lk-swatch-field" data-kind="add"><Icon name="plus" size={16} /></span>
              <span className="lk-swatch-label">{uploading ? 'Adding…' : state.image ? 'Replace' : 'Your picture'}</span>
            </label>
          </div>
          {state.image ? (
            <Toolbar align="end">
              <Button size="sm" variant="ghost" onClick={() => change(api.removeLockBackground())}>Remove picture</Button>
            </Toolbar>
          ) : null}
        </div>
      </Stack>
      {dialog ? <PinDialog kind={dialog} onClose={() => setDialog(null)} onDone={(next) => { setDialog(null); take(next); }} /> : null}
    </Section>
    <LockFaceEditor clock={state.clock} onClock={(clock) => change(api.setLockSettings({ clock }))} version={`${state.background}:${state.image ?? ''}:${JSON.stringify(state.clock ?? null)}`} />
    </>
  );
}
