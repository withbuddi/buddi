/**
 * One tip on Home (docs/dashboard.md, Home): when something in buddi has gone
 * unused, one sentence and one action, at most one a day.
 *
 * The action goes where the tip points. "Not this again" removes the tip for
 * good; the quiet × puts it off, and it may come back after a while. Tips are
 * turned off on Settings → Notifications, and then the gateway serves none.
 */
import { useState } from 'react';
import { api, type TipView } from '../../api';
import { Button, Notice, Spacer, Toolbar, useAsync } from '../../ui';
import { Icon } from '../../ui/Icon';

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
      <Notice>
        <div className="ui-notice-row">
          <p className="ui-notice-body">{tip.text}</p>
          <button type="button" className="ui-icon-btn" data-size="sm" aria-label="Not now" title="Not now" onClick={() => leave('later')}>
            <Icon name="close" />
          </button>
        </div>
        <Toolbar>
          <Spacer />
          <Button variant="ghost" size="sm" onClick={() => leave('dismiss')}>Not this again</Button>
          <Button variant="accent" size="sm" onClick={() => navigate(tip.action.route)}>{tip.action.label}</Button>
        </Toolbar>
      </Notice>
    </div>
  );
}
