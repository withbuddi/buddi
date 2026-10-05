/**
 * The tips (docs/dashboard.md, Home), as a small hand of cards in the panel
 * the lightbulb on Home opens: today's tip in front, up to two more peeking
 * out behind, "1 of N" under them.
 *
 * Slide the front card left for "Not now" (it may come back after a while),
 * right for "Not this again" (never). The same under the stack as two buttons
 * and the arrow keys; the action on the card is a click and Enter. A drag
 * short of the threshold snaps back. With reduced motion the card crossfades
 * instead of flying. When the last card goes, the stack folds away and the
 * panel says there are none.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { api, type TipView } from '../../api';
import { useMediaQuery } from '../../useMediaQuery';
import { Button, useAsync } from '../../ui';
import { Icon } from '../../ui/Icon';
import { NeedsCard } from './NeedsCard';

/** `#/?tip=<id>[,<id>…]` on Home stacks those tips as they would look, touching no state. */
export function previewTipOf(hash: string): string | undefined {
  const at = hash.indexOf('?');
  if (at === -1) return undefined;
  const id = new URLSearchParams(hash.slice(at + 1)).get('tip');
  return id && /^[a-z0-9-]{1,40}(,[a-z0-9-]{1,40}){0,4}$/.test(id) ? id : undefined;
}

export type TipLeave = 'later' | 'dismiss';

/** How many cards are drawn: the front one and two peeking behind it. */
export const TIP_STACK_DRAWN = 3;
/** The fly-off, in ms (the kit's `--dur-slow`). */
export const TIP_FLY_MS = 320;
/** The next card settling, and the crossfade under reduced motion (`--dur`). */
export const TIP_SETTLE_MS = 160;
/** Past this share of the card's width (or `TIP_DRAG_MAX` px, if less), a drag sends the card off. */
const TIP_DRAG_SHARE = 0.3;
const TIP_DRAG_MAX = 120;
/** Degrees of tilt per pixel dragged, and the most. */
const TIP_TILT = 0.06;
const TIP_TILT_MAX = 14;

export interface TipQueue {
  /** The tips still in the stack, front first. */
  tips: TipView[];
  /** Whether the stack is drawn: true from the first tip until it has folded away. */
  shown: boolean;
  /** The gateway has answered (or failed). */
  loaded: boolean;
  error: string | null;
  /** A card leaves: at once here, the gateway told on the side. */
  leave: (id: string, how: TipLeave) => void;
  /** The stack has folded away after its last card. */
  folded: () => void;
}

/**
 * The tips: the queue (GET /api/tips/queue) and what the owner did with it
 * here. A failed later/dismiss only means the tip may be back another day.
 * `peek` while the stack is closed: the gateway marks nothing shown until the
 * owner opens it.
 */
export function useTipQueue(preview?: string, peek = false): TipQueue {
  const queue = useAsync(() => api.tipQueue(preview, peek), [preview, peek]);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [folded, setFolded] = useState(false);
  const all = queue.data?.tips ?? [];
  const tips = all.filter((tip) => !gone.has(tip.id));
  const quiet = Boolean(preview || queue.data?.preview);
  const leave = useCallback((id: string, how: TipLeave): void => {
    setGone((current) => new Set(current).add(id));
    if (quiet) return;
    void (how === 'dismiss' ? api.dismissTip(id) : api.laterTip(id)).catch(() => {});
  }, [quiet]);
  return {
    tips,
    shown: all.length > 0 && !(tips.length === 0 && folded),
    loaded: queue.data !== undefined || queue.error !== null,
    error: queue.error,
    leave,
    folded: useCallback(() => setFolded(true), []),
  };
}

/** The card in front and where it is going. */
type Motion =
  | { kind: 'rest' }
  | { kind: 'drag'; dx: number }
  | { kind: 'snap' }
  | { kind: 'fly'; id: string; how: TipLeave };

function tilt(dx: number): number {
  return Math.max(-TIP_TILT_MAX, Math.min(TIP_TILT_MAX, dx * TIP_TILT));
}

export function TipStack({ queue, navigate }: { queue: TipQueue; navigate: (route: string) => void }): JSX.Element | null {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [motion, setMotion] = useState<Motion>({ kind: 'rest' });
  const front = useRef<HTMLDivElement | null>(null);
  const group = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { tips, leave, folded } = queue;
  const empty = tips.length === 0;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The last card gone: fold away over `--dur`, then say so.
  useEffect(() => {
    if (!empty || !queue.shown) return undefined;
    const t = setTimeout(folded, TIP_SETTLE_MS);
    return () => clearTimeout(t);
  }, [empty, queue.shown, folded]);

  const send = useCallback((how: TipLeave): void => {
    const tip = tips[0];
    if (!tip || motion.kind === 'fly') return;
    setMotion({ kind: 'fly', id: tip.id, how });
    timer.current = setTimeout(() => {
      leave(tip.id, how);
      setMotion({ kind: 'rest' });
    }, reduced ? TIP_SETTLE_MS : TIP_FLY_MS);
  }, [tips, motion.kind, leave, reduced]);

  if (!queue.shown) return null;

  const tip = tips[0];
  const flying = motion.kind === 'fly';
  // While the front card flies, the ones behind already move up.
  const drawn = tips.slice(0, TIP_STACK_DRAWN + (flying ? 1 : 0));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (flying || event.button > 0) return;
    if ((event.target as HTMLElement).closest('button, a, input')) return;
    drag.current = { id: event.pointerId, x: event.clientX, width: event.currentTarget.offsetWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setMotion({ kind: 'drag', dx: 0 });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    setMotion({ kind: 'drag', dx: event.clientX - d.x });
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    const dx = event.type === 'pointercancel' ? 0 : event.clientX - d.x;
    // An unmeasured card (no layout yet) goes by the fixed distance.
    const threshold = d.width > 0 ? Math.min(TIP_DRAG_MAX, d.width * TIP_DRAG_SHARE) : TIP_DRAG_MAX;
    if (Math.abs(dx) >= threshold) send(dx < 0 ? 'later' : 'dismiss');
    else setMotion({ kind: 'snap' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); send('later'); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); send('dismiss'); }
    else if (event.key === 'Enter' && event.target === event.currentTarget && tip) { event.preventDefault(); navigate(tip.action.route); }
  };

  /** The front card's transform while dragged or flying; the rest come from the stylesheet. */
  const frontStyle = (): CSSProperties | undefined => {
    if (motion.kind === 'drag') return { transform: `translateX(${motion.dx}px) rotate(${tilt(motion.dx)}deg)`, transition: 'none' };
    if (motion.kind === 'fly' && !reduced) {
      const dir = motion.how === 'later' ? -1 : 1;
      const width = front.current?.offsetWidth ?? 400;
      return { transform: `translateX(${dir * width * 0.8}px) rotate(${dir * TIP_TILT_MAX * 1.3}deg)` };
    }
    return undefined;
  };

  const count = tips.length;
  return (
    <div className="tip-stack-fold" data-empty={empty ? 'true' : undefined}>
      <div className="tip-stack-fold-inner">
        <div
          ref={group}
          className="tip-stack"
          role="group"
          aria-roledescription="stack of tips"
          aria-label={tip ? `Tips, 1 of ${count}. Left arrow: not now. Right arrow: not this again. Enter: ${tip.action.label}.` : 'Tips'}
          tabIndex={empty ? -1 : 0}
          onKeyDown={onKeyDown}
          data-motion={reduced ? 'reduced' : 'full'}
          data-depth={Math.min(count, TIP_STACK_DRAWN) - 1}
          data-testid="tip-stack"
        >
          {drawn.map((t, index) => {
            const isFront = index === 0;
            const leaving = flying && isFront;
            // Behind a flying card, every card is already one step forward.
            const depth = flying ? Math.max(0, index - 1) : index;
            return (
              <div
                key={t.id}
                ref={isFront ? front : undefined}
                className="tip-stack-card"
                data-tip={t.id}
                data-depth={leaving ? 'leaving' : depth}
                data-dragging={isFront && motion.kind === 'drag' ? 'true' : undefined}
                data-leaving={leaving ? motion.how : undefined}
                style={{ zIndex: drawn.length - index, ...(isFront ? frontStyle() : {}) } as CSSProperties}
                aria-hidden={isFront ? undefined : true}
                // React 18 has no `inert` prop; the attribute keeps the cards behind out of Tab.
                {...(isFront ? {} : ({ inert: '' } as Record<string, string>))}
                {...(isFront
                  ? { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd }
                  : {})}
              >
                <NeedsCard
                  kind="tip"
                  tone="accent"
                  icon="bulb"
                  title={t.text}
                  from="A tip from buddi"
                  actions={
                    <Button variant="accent" tabIndex={isFront && !leaving ? undefined : -1} onClick={() => navigate(t.action.route)}>
                      {t.action.label}
                    </Button>
                  }
                />
              </div>
            );
          })}
        </div>
        {tip ? (
          <div className="tip-stack-nav">
            <Button variant="ghost" size="sm" title="It may come back after a while" disabled={flying} onClick={() => send('later')}>
              <Icon name="chevron-left" size={14} />Not now
            </Button>
            <span className="tip-stack-count" aria-live="polite">1 of {count}</span>
            <Button variant="ghost" size="sm" title="Never show this tip again" disabled={flying} onClick={() => send('dismiss')}>
              Not this again<Icon name="chevron-right" size={14} />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
