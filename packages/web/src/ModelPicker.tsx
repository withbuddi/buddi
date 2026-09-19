import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Button, Field, Stack } from './ui';

/** Remount when the account/revision changes; fetching never selects a model. */
export function ModelPicker({ accountId, label, value, onChange, disabled = false }: {
  accountId?: string; label: string; value: string; onChange(value: string): void; disabled?: boolean;
}): JSX.Element {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.accountModels>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [custom, setCustom] = useState(false);
  const sequence = useRef(0);
  const load = async (refresh: boolean) => {
    if (!accountId) return;
    const attempt = ++sequence.current;
    setBusy(true); setError('');
    try {
      const next = await api.accountModels(accountId, refresh);
      if (attempt === sequence.current) setList(next);
    } catch (e) {
      if (attempt === sequence.current) setError(e instanceof Error ? e.message : 'Could not load models. Custom entry is still available.');
    } finally { if (attempt === sequence.current) setBusy(false); }
  };
  useEffect(() => {
    setList(null); setCustom(false); setError('');
    void load(false);
    return () => { sequence.current++; };
  }, [accountId]);
  if (!accountId) return (
    <Field label={label} hint="Save and connect the account to load its model list. You can enter a model manually now.">
      <input required maxLength={150} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} />
    </Field>
  );
  const models = list?.models ?? [];
  const absent = !!value && !models.some(m => m.id === value);
  const hint = [
    list && !models.length ? 'This account returned no models. You can enter a custom model.' : null,
    list?.truncated ? 'Showing the first part of this provider’s list. Custom model entry is available.' : null,
    list ? 'Uses saved account settings. Listed models may not support every agent tool. Your selection is unchanged until you save.' : null,
  ].filter(Boolean).join(' ');
  return (
    <Stack gap="sm">
      <div className="ui-row" data-align="end">
        <Field label={label} hint={hint || undefined}>
          <select value={custom ? '__buddi_custom__' : value} disabled={disabled} onChange={e => {
            if (e.target.value === '__buddi_custom__') setCustom(true);
            else { setCustom(false); onChange(e.target.value); }
          }}>
            <option value="" disabled>Choose a model</option>
            {absent && <option value={value}>{value} (current{list ? ', not listed' : ''})</option>}
            {models.map(m => <option key={m.id} value={m.id}>{m.name === m.id ? m.id : `${m.name} — ${m.id}`}{m.isDefault ? ' (provider default)' : ''}</option>)}
            <option value="__buddi_custom__">Custom model…</option>
          </select>
        </Field>
        <Button disabled={disabled || busy} onClick={() => void load(true)}>{busy ? 'Loading models…' : 'Refresh models'}</Button>
      </div>
      {custom && (
        <Field label={`Custom ${label.toLowerCase()}`}>
          <input required maxLength={150} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} />
        </Field>
      )}
      {error && <div role="alert" className="muted">{error}</div>}
    </Stack>
  );
}
