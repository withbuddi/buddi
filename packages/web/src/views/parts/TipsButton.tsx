/**
 * The lightbulb on Home's greeting row (docs/dashboard.md, Home): every tip
 * and where it stands, in a sheet. A small dot on it when a tip is due today
 * and Home is not showing it (tips are off).
 *
 * Each row: the sentence, a muted status word, the action, and for a
 * dismissed tip "Bring back". At the foot the same "Tips on Home" switch as
 * Settings → Notifications, saved at once. The list reads while tips are off.
 */
import { useState } from 'react';
import { api, ApiError, type TipListRow } from '../../api';
import { Button, ErrorBanner, Sheet, Spacer, Toolbar, useAsync } from '../../ui';
import { Icon } from '../../ui/Icon';

/** `YYYY-MM-DD` as "Sep 27". */
function fmtDate(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return day;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(at);
}

export function tipStatusWord(row: TipListRow): string {
  switch (row.status) {
    case 'today': return 'Due today';
    case 'holding': return 'Waiting';
    case 'quiet': return 'Not needed now';
    case 'dismissed': return 'Dismissed';
    case 'shown': return row.shownAt ? `Shown on ${fmtDate(row.shownAt)}` : 'Shown';
  }
}

export function TipsButton({ navigate }: { navigate: (route: string) => void }): JSX.Element {
  const list = useAsync(() => api.tips(), []);
  const [open, setOpen] = useState(false);
  const due = !!list.data && !list.data.enabled && list.data.tips.some((t) => t.status === 'today');

  return (
    <>
      <button
        type="button"
        className="ui-icon-btn home-tips-btn"
        aria-label={due ? 'Tips, one due today' : 'Tips'}
        title="Tips"
        data-open={open}
        onClick={() => { setOpen(true); list.reload(); }}
      >
        <Icon name="bulb" />
        {due ? <span className="home-tips-dot" data-testid="tips-dot" /> : null}
      </button>
      {open ? (
        <TipsSheet
          rows={list.data?.tips ?? null}
          enabled={list.data?.enabled ?? true}
          error={list.error}
          reload={list.reload}
          onClose={() => setOpen(false)}
          navigate={(route) => { setOpen(false); navigate(route); }}
        />
      ) : null}
    </>
  );
}

function TipsSheet({
  rows,
  enabled,
  error,
  reload,
  onClose,
  navigate,
}: {
  rows: TipListRow[] | null;
  enabled: boolean;
  error: string | null | undefined;
  reload: () => void;
  onClose: () => void;
  navigate: (route: string) => void;
}): JSX.Element {
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const checked = on ?? enabled;
  const say = (e: unknown): void => setFailed(e instanceof ApiError ? e.message : String(e));

  const restore = (id: string): void => {
    setBusy(id);
    setFailed(null);
    api.restoreTip(id).then(() => reload(), say).finally(() => setBusy(null));
  };

  const change = (next: boolean): void => {
    setBusy('switch');
    setFailed(null);
    setOn(next);
    api
      .saveTipsSettings(next)
      .then((saved) => { setOn(saved.enabled); reload(); })
      .catch((e: unknown) => { setOn(!next); say(e); })
      .finally(() => setBusy(null));
  };

  return (
    <Sheet title="Tips" onClose={onClose}>
      <ErrorBanner message={error ?? failed} />
      <div className="tips-list">
        {(rows ?? []).map((row) => (
          <div className="tips-row" key={row.id} data-tip={row.id} data-status={row.status}>
            <p className="tips-row-text">{row.text}</p>
            <Toolbar>
              <span className="ui-card-meta tips-row-status">{tipStatusWord(row)}</span>
              <Spacer />
              {row.status === 'dismissed' ? (
                <Button variant="ghost" size="sm" disabled={busy === row.id} onClick={() => restore(row.id)}>Bring back</Button>
              ) : null}
              <Button size="sm" onClick={() => navigate(row.action.route)}>{row.action.label}</Button>
            </Toolbar>
          </div>
        ))}
      </div>
      <div className="tips-foot">
        <label className="backup-check">
          <input type="checkbox" checked={checked} disabled={busy === 'switch' || rows === null} onChange={(e) => change(e.target.checked)} />
          <span>Tips on Home</span>
        </label>
      </div>
    </Sheet>
  );
}
