/**
 * The glances at the top of Home.
 *
 * A glance is a plugin's one line — "☁ 18°C Lyon" — shown beside the date:
 * at most three, in plugin order, each a quiet link to its plugin's page, with
 * a small × that shows on hover or focus and hides it for good (Settings →
 * Appearance shows it again).
 *
 * A glance may also send a card (a figure, a quiet line, a short run of
 * numbers, a foot). The first shown glance with one is drawn as a card on the
 * right of the greeting, with the Blob in it, and leaves the date line; with
 * none, the Blob stands there alone. Nothing here knows a plugin: a glyph from
 * the pinned set and already formatted text and numbers.
 */
import { useState, type ReactNode } from 'react';
import { api, type HomeGlance } from '../../api';
import { tileGlyph } from '../../canvas/tileIcons';
import { pluginPageHref } from '../../pages/pageLinks';
import { Icon } from '../../ui/Icon';

export const HOME_GLANCES_SHOWN = 3;

/** The ones Home draws: not hidden, the first three. */
export function shownGlances(glances: readonly HomeGlance[] | undefined, hiddenHere: ReadonlySet<string> = new Set()): HomeGlance[] {
  return (glances ?? []).filter((g) => !g.hidden && !hiddenHere.has(g.id)).slice(0, HOME_GLANCES_SHOWN);
}

/** The glance Home draws as the card: the first shown one that sent a card. */
export function cardGlance(glances: readonly HomeGlance[] | undefined): HomeGlance | null {
  return shownGlances(glances).find((g) => g.card !== undefined) ?? null;
}

/**
 * Hide one glance: gone at once, remembered by the server, back if the save
 * fails. The page re-reads the overview after.
 */
function useHide(onChanged?: () => void): { hiddenHere: ReadonlySet<string>; hide: (glance: HomeGlance) => void } {
  const [hiddenHere, setHiddenHere] = useState<Set<string>>(new Set());
  const hide = (glance: HomeGlance): void => {
    setHiddenHere((current) => new Set(current).add(glance.id));
    void api.setGlanceHidden(glance.id, true).then(() => onChanged?.(), () => {
      setHiddenHere((current) => {
        const next = new Set(current);
        next.delete(glance.id);
        return next;
      });
    });
  };
  return { hiddenHere, hide };
}

function hrefOf(glance: HomeGlance): string | null {
  return glance.link ? pluginPageHref(glance.link.plugin, glance.link.page, glance.link.place) : null;
}

export function HomeGlances({
  glances,
  navigate,
  onChanged,
  except,
}: {
  glances: readonly HomeGlance[] | undefined;
  navigate: (route: string) => void;
  /** After a hide is saved: the page re-reads the overview. */
  onChanged?: () => void;
  /** The glance drawn as the card, left off the line. */
  except?: string | undefined;
}): JSX.Element | null {
  const { hiddenHere, hide } = useHide(onChanged);
  const shown = shownGlances(glances, hiddenHere).filter((g) => g.id !== except);
  if (shown.length === 0) return null;
  return (
    <span className="home-glances">
      {shown.map((glance) => {
        const href = hrefOf(glance);
        const body = (
          <>
            <Icon name={tileGlyph(glance.icon)} size={14} />
            <span>{glance.text}</span>
          </>
        );
        return (
          <span key={glance.id} className="home-glance">
            <span className="home-glance-sep" aria-hidden="true">·</span>
            {href ? (
              <a className="home-glance-text" href={href} onClick={(event) => { event.preventDefault(); navigate(href); }}>
                {body}
              </a>
            ) : (
              <span className="home-glance-text">{body}</span>
            )}
            <button type="button" className="home-glance-hide" aria-label={`Hide ${glance.title} from Home`} title="Hide from Home" onClick={() => hide(glance)}>
              <Icon name="close" size={10} />
            </button>
          </span>
        );
      })}
    </span>
  );
}

/** Where a sparkline's points land in a 100 × 24 box, with room for the stroke. */
export function sparkPoints(points: readonly number[]): Array<[number, number]> {
  const width = 100;
  const height = 24;
  const pad = 2;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || 1;
  const last = Math.max(points.length - 1, 1);
  return points.map((p, i) => [(i / last) * width, pad + (1 - (p - lo) / span) * (height - pad * 2)]);
}

/** A run of numbers as one line and a soft area under it: no axis, no labels. */
function Spark({ points }: { points: readonly number[] }): JSX.Element {
  const xy = sparkPoints(points).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`);
  return (
    <svg className="home-spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" data-testid="spark">
      <path d={`M0,24 L${xy.join(' L')} L100,24 Z`} fill="currentColor" opacity="0.12" stroke="none" />
      <polyline points={xy.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * The card on the right of the greeting, the Blob in it. Hidden with its ×,
 * it leaves `alone` (the Blob by itself) in its place.
 */
export function HomeGlanceCard({
  glance,
  navigate,
  onChanged,
  blob,
}: {
  glance: HomeGlance;
  navigate: (route: string) => void;
  onChanged?: () => void;
  /** The Blob: drawn in the card, or alone once the card is hidden. */
  blob: ReactNode;
}): JSX.Element {
  const { hiddenHere, hide } = useHide(onChanged);
  const card = glance.card;
  if (!card || hiddenHere.has(glance.id)) return <>{blob}</>;
  const href = hrefOf(glance);
  const body = (
    <>
      <span className="home-weather-now">
        <span className="home-weather-icon"><Icon name={tileGlyph(glance.icon)} size={30} /></span>
        <span className="home-weather-value">{card.value}</span>
      </span>
      {card.caption ? <span className="home-weather-caption">{card.caption}</span> : null}
      {card.trend ? (
        <span className="home-weather-trend">
          <Spark points={card.trend.points} />
          {card.trend.label ? <span>{card.trend.label}</span> : null}
        </span>
      ) : null}
      {card.foot ? <span className="home-weather-foot">{card.foot}</span> : null}
    </>
  );
  return (
    <div className="home-weather" role="group" aria-label={glance.title}>
      {href ? (
        <a className="home-weather-main" href={href} onClick={(event) => { event.preventDefault(); navigate(href); }}>{body}</a>
      ) : (
        <div className="home-weather-main">{body}</div>
      )}
      {blob}
      <button type="button" className="home-weather-hide" aria-label={`Hide ${glance.title} from Home`} title="Hide from Home" onClick={() => hide(glance)}>
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}
