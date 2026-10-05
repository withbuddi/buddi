/**
 * One tip on Home (docs/dashboard.md, Home): when something in buddi has gone
 * unused, one sentence and one action, at most one a day.
 *
 * The action goes where the tip points. "Not this again" removes the tip for
 * good; "Not now" puts it off, and it may come back after a while. Tips are
 * turned off on Settings → Notifications, and then the gateway serves none.
 */
import { useState } from 'react';
import { api, type TipView } from '../../api';
import { Button, useAsync } from '../../ui';
import { NeedsCard } from './NeedsCard';

/** `#/?tip=<id>` on Home shows that one tip as it would look, touching no state. */
export function previewTipOf(hash: string): string | undefined {
  const at = hash.indexOf('?');
  if (at === -1) return undefined;
  const id = new URLSearchParams(hash.slice(at + 1)).get('tip');
  return id && /^[a-z0-9-]{1,40}$/.test(id) ? id : undefined;
}

/** `hidden` while the Tips section is open, so the tip is not shown twice; it stays mounted and is not fetched again. */
export function TipCard({ navigate, preview, hidden }: { navigate: (route: string) => void; preview?: string; hidden?: boolean }): JSX.Element | null {
  const current = useAsync(() => api.currentTip(preview), [preview]);
  const [gone, setGone] = useState<string | null>(null);
  const tip = current.data?.tip ?? null;
  if (!tip || gone === tip.id || hidden) return null;

  // It leaves at once; the gateway is told on the side, and a failed call
  // only means the tip may be back tomorrow.
  const leave = (how: 'dismiss' | 'later'): void => {
    setGone(tip.id);
    if (preview) return;
    void (how === 'dismiss' ? api.dismissTip(tip.id) : api.laterTip(tip.id)).catch(() => {});
  };

  return (
    <div className="home-tip" data-tip={tip.id}>
      <NeedsCard
        kind="tip"
        tone="accent"
        icon="bulb"
        title={tip.text}
        from="A tip from buddi"
        dismiss={{ onClick: () => leave('later'), hint: 'It may come back after a while' }}
        extraDismiss={{ onClick: () => leave('dismiss'), hint: 'Never show this tip again' }}
        actions={<Button variant="accent" onClick={() => navigate(tip.action.route)}>{tip.action.label}</Button>}
      />
    </div>
  );
}
