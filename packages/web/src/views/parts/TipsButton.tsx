/**
 * The lightbulb on Home's greeting row (docs/dashboard.md, Home) and the Tips
 * section it opens right under that row: every tip and where it stands, one
 * card each. A small dot on the bulb when a tip is due today and Home is not
 * showing it (tips are off). The bulb shows pressed while the section is
 * open; whether it is open is kept in this browser (`buddi.tipsOpen`),
 * closed by default.
 *
 * Each card: a status pill, the sentence, and on the right the action, or
 * "Bring back" for a dismissed tip. Under the cards the same "Tips on Home"
 * switch as Settings → Notifications, saved at once, and "Close". The cards
 * read while tips are off.
 */
import { useCallback, useState } from 'react';
import { api, ApiError, type TipListRow } from '../../api';
import { Button, Card, ErrorBanner, Pill, Section, Spacer, Toolbar, useAsync } from '../../ui';
import { Icon } from '../../ui/Icon';
import { fmtDay } from '../../format';

/** Set to '1' while the Tips section on Home is open. */
export const TIPS_OPEN_KEY = 'buddi.tipsOpen';

/** `YYYY-MM-DD` as "Sep 27". */
function fmtDate(day: string): string {
  return fmtDay(day, { compact: true });
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

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(TIPS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export interface Tips {
  open: boolean;
  setOpen: (open: boolean) => void;
  list: { data: { tips: TipListRow[]; enabled: boolean } | undefined; error: string | null; reload: () => void };
}

/** The tips list and whether the section is open: shared by the bulb and the section. */
export function useTips(): Tips {
  const list = useAsync(() => api.tips(), []);
  const [open, setOpenState] = useState(readOpen);
  const setOpen = useCallback((next: boolean): void => {
    setOpenState(next);
    try {
      if (next) window.localStorage.setItem(TIPS_OPEN_KEY, '1');
      else window.localStorage.removeItem(TIPS_OPEN_KEY);
    } catch {
      /* a private window: open for this visit only */
    }
  }, []);
  return { open, setOpen, list };
}

export function TipsButton({ tips }: { tips: Tips }): JSX.Element {
  const { open, setOpen, list } = tips;
  const due = !!list.data && !list.data.enabled && list.data.tips.some((t) => t.status === 'today');
  return (
    <button
      type="button"
      className="ui-icon-btn home-tips-btn"
      aria-label={due ? 'Tips, one due today' : 'Tips'}
      aria-pressed={open}
      title="Tips"
      data-open={open}
      onClick={() => {
        if (!open) list.reload();
        setOpen(!open);
      }}
    >
      <Icon name="bulb" />
      {due ? <span className="home-tips-dot" data-testid="tips-dot" /> : null}
    </button>
  );
}

export function TipsSection({ tips, navigate }: { tips: Tips; navigate: (route: string) => void }): JSX.Element | null {
  const { open, setOpen, list } = tips;
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  if (!open) return null;

  const rows = list.data?.tips ?? null;
  const checked = on ?? list.data?.enabled ?? true;
  const say = (e: unknown): void => setFailed(e instanceof ApiError ? e.message : String(e));

  const restore = (id: string): void => {
    setBusy(id);
    setFailed(null);
    api.restoreTip(id).then(() => list.reload(), say).finally(() => setBusy(null));
  };

  const change = (next: boolean): void => {
    setBusy('switch');
    setFailed(null);
    setOn(next);
    api
      .saveTipsSettings(next)
      .then((saved) => { setOn(saved.enabled); list.reload(); })
      .catch((e: unknown) => { setOn(!next); say(e); })
      .finally(() => setBusy(null));
  };

  return (
    <div className="home-tips" data-testid="tips-section">
      <Section title="Tips">
        <ErrorBanner message={list.error ?? failed} />
        <div className="tips-grid">
          {(rows ?? []).map((row) => (
            <div className="tips-card" key={row.id} data-tip={row.id} data-status={row.status}>
              <Card tone={row.status === 'today' ? 'accent' : undefined}>
                <div>
                  <Pill tone={row.status === 'today' ? 'accent' : 'muted'}>{tipStatusWord(row)}</Pill>
                </div>
                <p className="tips-card-text">{row.text}</p>
                <Toolbar>
                  <Spacer />
                  {row.status === 'dismissed' ? (
                    <Button size="sm" disabled={busy === row.id} onClick={() => restore(row.id)}>Bring back</Button>
                  ) : (
                    <Button size="sm" variant={row.status === 'today' ? 'accent' : undefined} onClick={() => navigate(row.action.route)}>
                      {row.action.label}
                    </Button>
                  )}
                </Toolbar>
              </Card>
            </div>
          ))}
        </div>
        <Toolbar>
          <label className="backup-check">
            <input type="checkbox" checked={checked} disabled={busy === 'switch' || rows === null} onChange={(e) => change(e.target.checked)} />
            <span>Tips on Home</span>
          </label>
          <Spacer />
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
        </Toolbar>
      </Section>
    </div>
  );
}
