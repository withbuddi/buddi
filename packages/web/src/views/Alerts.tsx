/**
 * Alerts: decisions, not chores (docs/dashboard.md, "Alerts").
 *
 * Only what needs a decision is listed — urgent findings, each in the one line
 * its watcher wrote for the owner (never the brief it hands an agent), and
 * repeats of one kind as one row with the subjects inside. Each row has the
 * primary action its finding declared, one secondary, Not now (a week) and ⋯
 * with Ask and Stop telling me this; Clear all puts everything listed off for
 * a week, with Undo. What the watchers notice in passing is not listed: it
 * waits for the weekly recap, counted in one line whose Preview lists it.
 */
import { useState } from 'react';
import { api, ApiError, type AlertAction, type AlertGroup } from '../api';
import type { ChatAgent } from '../chat/types';
import { fmtRelative } from '../format';
import { chatRoute, FILES_ROUTE, pluginPageRoute, settingsRoute } from '../routes';
import { UndoToast } from '../shell/UndoToast';
import { ActionMenu, Button, ErrorBanner, Icon, Modal, PageFrame, Panel, Sheet, useAsync } from '../ui';

/** How long Not now and Clear all keep a row away. */
export const NOT_NOW_DAYS = 7;
const UNDO_MS = 10_000;

type Toast = { id: number; title: string; body?: string; undo?: () => Promise<unknown> };

export function Alerts({
  timezone,
  embedded,
  agents = [],
  navigate,
}: {
  timezone: string;
  embedded?: boolean;
  agents?: ChatAgent[];
  navigate?: (route: string) => void;
}): JSX.Element {
  const { data, error, reload } = useAsync(() => api.sentinels(), [], 30_000);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [form, setForm] = useState<Extract<AlertAction, { kind: 'fill' }> | null>(null);
  const [confirm, setConfirm] = useState<Extract<AlertAction, { kind: 'run' }> | null>(null);
  const [recapOpen, setRecapOpen] = useState(false);
  const [show, setShow] = useState<'snoozed' | 'resolved' | null>(null);
  const alerts = data?.alerts;
  const open = alerts?.open ?? [];
  const go = (route: string): void => { if (navigate) navigate(route); else window.location.hash = route; };
  const nameOf = (id: string | null): string | null => (id ? agents.find((a) => a.id === id)?.name ?? null : null);

  const attempt = async (work: () => Promise<void>): Promise<void> => {
    setFailure(null);
    try { await work(); }
    catch (err) { setFailure(err instanceof ApiError || err instanceof Error ? err.message : String(err)); }
    finally { reload(); }
  };
  const say = (t: Omit<Toast, 'id'>): void => setToast({ ...t, id: Date.now() });

  const snooze = (keys: string[], title: string, days?: number): Promise<void> =>
    attempt(async () => {
      const { keys: changed } = await api.snoozeAlerts(keys, true, days);
      say({ title, undo: () => api.snoozeAlerts(changed, false) });
    });
  const stop = (g: AlertGroup): Promise<void> =>
    attempt(async () => {
      const { id } = await api.muteAlert(g.keys[0]!, g.stop.scope);
      say({ title: 'You won’t hear about this again', body: 'Turn it back on in Settings → Watchers.', undo: () => api.unmuteAlert(id) });
    });
  const ask = (g: AlertGroup): Promise<void> =>
    attempt(async () => {
      const { agentId, conversationId } = await api.askAboutAlerts(g.keys);
      go(chatRoute(agentId, conversationId));
    });
  const run = (a: Extract<AlertAction, { kind: 'run' }>): Promise<void> =>
    attempt(async () => {
      const [result] = (await api.actOnAlerts([{ key: a.key, action: a.index }])).results;
      if (result?.error) throw new Error(result.error);
      if (result?.approvalId) say({ title: 'Waiting for your approval', body: 'Decide it in Needs you on Home.' });
      else say({ title: `${a.label}: done` });
    });
  const act = (g: AlertGroup, a: AlertAction): void => {
    if (a.kind === 'open') go(a.place === 'files' ? FILES_ROUTE : a.plugin && a.page ? pluginPageRoute(a.plugin, a.page, a.item) : FILES_ROUTE);
    else if (a.kind === 'ask') void ask(g);
    else if (a.kind === 'dismiss') void snooze(g.keys, 'Set aside until it changes');
    else if (a.kind === 'fill') setForm(a);
    else if (a.confirm) setConfirm(a);
    else void run(a);
  };

  const clearAll = (): void => {
    const keys = open.flatMap((g) => g.keys);
    void snooze(keys, `Cleared ${open.length} for a week`, NOT_NOW_DAYS);
  };
  const recap = alerts?.recap;
  const recapName = recapLabel(recap?.nextAt ?? null, timezone);

  return (
    <PageFrame embedded={embedded} title="Alerts" lede="What needs a decision from you.">
      <ErrorBanner message={error ?? failure} />
      <Panel
        flush
        title="Needs a decision"
        tool={open.length > 0 ? String(open.length) : undefined}
        actions={open.length > 1 ? <Button size="sm" variant="ghost" onClick={clearAll}>Clear all</Button> : undefined}
      >
        {!data ? null : open.length === 0 ? (
          <div className="al-empty">
            <Icon name="check" />
            <div>
              <p className="al-empty-title">Nothing needs a decision.</p>
              <p className="al-empty-line">Your watchers are quiet. What they notice in passing waits for {recapName}.</p>
            </div>
          </div>
        ) : (
          <ul className="al-list">
            {open.map((g) => (
              <AlertRow key={g.id} group={g} agentName={nameOf(g.agentId)} onAct={act} onStop={stop}
                onNotNow={(row) => void snooze(row.keys, 'Snoozed for a week', NOT_NOW_DAYS)} />
            ))}
          </ul>
        )}
        {recap && recap.count > 0 ? (
          <p className="al-recap" data-testid="recap-line">
            <span>{recap.count} {recap.count === 1 ? 'note' : 'notes'} saved for {recapName}</span>
            <span aria-hidden="true">·</span>
            <button type="button" className="wb-link" onClick={() => setRecapOpen(true)}>Preview</button>
          </p>
        ) : null}
      </Panel>

      {alerts && (alerts.snoozed.length > 0 || alerts.resolved.length > 0) ? (
        <p className="al-quiet">
          {alerts.snoozed.length > 0 ? (
            <button type="button" className="wb-link" aria-expanded={show === 'snoozed'} onClick={() => setShow(show === 'snoozed' ? null : 'snoozed')}>
              {alerts.snoozed.length} snoozed
            </button>
          ) : null}
          {alerts.snoozed.length > 0 && alerts.resolved.length > 0 ? <span aria-hidden="true">·</span> : null}
          {alerts.resolved.length > 0 ? (
            <button type="button" className="wb-link" aria-expanded={show === 'resolved'} onClick={() => setShow(show === 'resolved' ? null : 'resolved')}>
              {alerts.resolved.length} resolved this week
            </button>
          ) : null}
        </p>
      ) : null}
      {show === 'snoozed' && alerts ? (
        <Panel flush title="Snoozed">
          <ul className="al-list">
            {alerts.snoozed.map((g) => (
              <li key={g.id} className="al-row">
                <div className="al-main">
                  <p className="al-title">{g.title}</p>
                  <p className="al-sub">{g.snoozedUntil ? `Back ${fmtRelative(g.snoozedUntil)}` : 'Until it changes'}</p>
                </div>
                <div className="al-actions">
                  <Button size="sm" onClick={() => void attempt(async () => { await api.snoozeAlerts(g.keys, false); })}>Bring back</Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      {show === 'resolved' && alerts ? (
        <Panel flush title="Resolved this week">
          <ul className="al-list">
            {alerts.resolved.map((g) => (
              <li key={g.id} className="al-row">
                <div className="al-main">
                  <p className="al-title">{g.title}</p>
                  <p className="al-sub">{g.resolvedAt ? `Resolved ${fmtRelative(g.resolvedAt)}` : null}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {recapOpen && recap ? (
        <Sheet title={capitalise(recapName)} onClose={() => setRecapOpen(false)}>
          <p className="al-form-note">
            What the watchers noted. buddi reads them out in {recapName}; nothing here needs you now, but you can act on one early.
          </p>
          <ul className="al-list al-list-sheet">
            {recap.groups.map((g) => (
              <AlertRow key={g.id} group={g} agentName={nameOf(g.agentId)} recap
                onAct={(row, a) => { if (a.kind !== 'fill') setRecapOpen(false); act(row, a); }}
                onStop={(row) => { void stop(row); }} />
            ))}
          </ul>
        </Sheet>
      ) : null}
      {form ? <FillSheet action={form} onClose={() => setForm(null)} onSaved={(n) => { setForm(null); setRecapOpen(false); say({ title: `Saved ${n}` }); reload(); }} /> : null}
      {confirm ? (
        <Modal
          title={confirm.label}
          onClose={() => setConfirm(null)}
          foot={<>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant={confirm.tone === 'danger' ? 'danger' : 'accent'} onClick={() => { const a = confirm; setConfirm(null); void run(a); }}>{confirm.label}</Button>
          </>}
        >
          <p>{confirm.confirm}</p>
        </Modal>
      ) : null}
      {toast ? (
        <UndoToast
          key={toast.id}
          title={toast.title}
          {...(toast.body ? { body: toast.body } : {})}
          duration={UNDO_MS}
          {...(toast.undo ? { onUndo: () => { const undo = toast.undo!; void attempt(async () => { await undo(); }); } } : {})}
          onGone={() => setToast(null)}
        />
      ) : null}
    </PageFrame>
  );
}

/** "Friday's recap" when the recap runs within the week, else "the weekly recap". */
export function recapLabel(nextAt: string | null, timezone: string, now = Date.now()): string {
  if (!nextAt) return 'the weekly recap';
  const at = new Date(nextAt);
  if (Number.isNaN(at.getTime()) || at.getTime() - now > 7 * 86_400_000) return 'the weekly recap';
  const day = new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: timezone }).format(at);
  return `${day}’s recap`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function actionLabel(a: AlertAction, agentName: string | null): string {
  if (a.kind === 'ask') return a.label ?? (agentName ? `Ask ${agentName}` : 'Ask about it');
  return a.label;
}

/** One decision: its line, who and since when, the primary, one secondary, Not now and ⋯. */
export function AlertRow({
  group,
  agentName,
  recap,
  onAct,
  onNotNow,
  onStop,
}: {
  group: AlertGroup;
  agentName: string | null;
  recap?: boolean;
  onAct: (g: AlertGroup, a: AlertAction) => void;
  onNotNow?: (g: AlertGroup) => void;
  onStop: (g: AlertGroup) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [primary, secondary, ...rest] = group.actions;
  const asked = group.actions.some((a) => a.kind === 'ask');
  const many = group.items.length > 1;
  return (
    <li className="al-row" data-urgent={group.urgent && !recap ? 'true' : undefined}>
      <div className="al-main">
        <p className="al-title">{group.title}</p>
        {group.line ? <p className="al-line">{group.line}</p> : null}
        <p className="al-sub">
          {agentName ? <span>{agentName}</span> : null}
          {agentName && !recap ? <span aria-hidden="true">·</span> : null}
          {!recap ? <span>noticed {fmtRelative(group.since)}</span> : null}
          {many ? (
            <>
              {agentName || !recap ? <span aria-hidden="true">·</span> : null}
              <button type="button" className="wb-link al-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Hide' : `Show the ${group.items.length}`}
              </button>
            </>
          ) : null}
        </p>
        {expanded && many ? (
          <ul className="al-items">
            {group.items.map((item) => (
              <li key={item.key} className="al-item">
                {item.subject ? <span className="al-item-who">{item.subject.label}</span> : null}
                <span className="al-item-note">{item.subject ? item.note : item.line}</span>
                {/* What is about this one alone — its Send, its Discard — stays on its row. */}
                {item.actions && item.actions.length > 0 ? (
                  <span className="al-item-actions">
                    {item.actions.map((a, i) => (
                      <Button key={i} size="sm" variant={a.kind === 'run' && a.tone === 'danger' ? 'danger-ghost' : 'ghost'} onClick={() => onAct(group, a)}>
                        {actionLabel(a, agentName)}
                      </Button>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="al-actions">
        {primary ? <Button size="sm" variant="accent" onClick={() => onAct(group, primary)}>{actionLabel(primary, agentName)}</Button> : null}
        {secondary ? (
          <Button size="sm" variant={secondary.kind === 'run' && secondary.tone === 'danger' ? 'danger-ghost' : undefined} onClick={() => onAct(group, secondary)}>
            {actionLabel(secondary, agentName)}
          </Button>
        ) : null}
        {onNotNow ? <Button size="sm" variant="ghost" onClick={() => onNotNow(group)}>Not now</Button> : null}
        <span className="al-more">
          <ActionMenu
            label={`More for ${group.title}`}
            sheet={{ title: group.title }}
            items={[
              ...rest.map((a) => ({ label: actionLabel(a, agentName), ...(a.kind === 'run' && a.tone === 'danger' ? { tone: 'critical' as const } : {}), onSelect: () => onAct(group, a) })),
              !asked && { label: agentName ? `Ask ${agentName}` : 'Ask about it', onSelect: () => onAct(group, { kind: 'ask', label: null }) },
              'separator',
              { label: 'Stop telling me this', hint: 'Undo in Settings → Watchers', onSelect: () => onStop(group) },
            ]}
          />
        </span>
      </div>
    </li>
  );
}

/**
 * The quick form: a row per subject with its last value, Save on the right.
 * A form of one is filled with that value; a form of many starts empty, so
 * what is left blank stays as it is.
 */
export function FillSheet({
  action,
  onClose,
  onSaved,
}: {
  action: Extract<AlertAction, { kind: 'fill' }>;
  onClose: () => void;
  onSaved: (count: number) => void;
}): JSX.Element {
  const single = action.fields.length === 1;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(action.fields.map((f) => [f.key, single && f.value !== null ? String(f.value) : ''])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const entries = action.fields
      .filter((f) => (values[f.key] ?? '').trim() !== '')
      .map((f) => ({ key: f.key, action: f.index, value: (values[f.key] ?? '').trim() }));
    if (entries.length === 0) { onClose(); return; }
    setBusy(true);
    setFailure(null);
    try {
      const { results } = await api.actOnAlerts(entries);
      const wrong = Object.fromEntries(results.filter((r) => r.error).map((r) => [r.key, r.error as string]));
      setErrors(wrong);
      if (Object.keys(wrong).length === 0) onSaved(entries.length);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={action.title}
      onClose={onClose}
      foot={<div className="al-form-foot">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="accent" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>}
    >
      <div className="al-form">
        <ErrorBanner message={failure} />
        <p className="al-form-note">
          {single ? 'Check it and save.' : 'Type what each is today. Leave the ones you don’t know; they stay as they are.'}
        </p>
        <div className="al-form-rows">
          {action.fields.map((f) => (
            <label key={f.key} className="al-form-row">
              <span className="al-form-label">
                <span>{f.label}</span>
                {f.hint ? <span className="al-form-hint">{f.hint}</span> : null}
              </span>
              <input
                type={f.type === 'date' ? 'date' : 'text'}
                inputMode={f.type === 'number' ? 'decimal' : undefined}
                value={values[f.key] ?? ''}
                placeholder="—"
                aria-label={f.label}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
              {errors[f.key] ? <span className="al-form-error">{errors[f.key]}</span> : null}
            </label>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/** Settings → Watchers' list of what the owner silenced, each with Tell me again. */
export function SilencedList({ mutes, onChanged }: { mutes: Array<{ id: string; label: string; createdAt: string }>; onChanged: () => void }): JSX.Element | null {
  const [failure, setFailure] = useState<string | null>(null);
  if (mutes.length === 0) return null;
  return (
    <Panel flush title="Silenced" tool={String(mutes.length)}>
      <ErrorBanner message={failure} />
      <ul className="al-list">
        {mutes.map((m) => (
          <li key={m.id} className="al-row">
            <div className="al-main">
              <p className="al-title al-silenced-label">{m.label}</p>
              <p className="al-sub">You said “Stop telling me this” {fmtRelative(m.createdAt)}</p>
            </div>
            <div className="al-actions">
              <Button size="sm" onClick={() => {
                setFailure(null);
                api.unmuteAlert(m.id).then(onChanged, (err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
              }}>Tell me again</Button>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Where Settings → Watchers lives, for a link. */
export const WATCHERS_ROUTE = settingsRoute('watchers');
