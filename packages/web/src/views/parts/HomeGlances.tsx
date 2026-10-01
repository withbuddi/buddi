/**
 * The glances at the top of Home.
 *
 * A glance is a plugin's one line — "☁ 18°C Lyon" — shown beside the date:
 * at most three, in plugin order, each a quiet link to its plugin's page, with
 * a small × that shows on hover or focus and hides it for good (Settings →
 * Appearance shows it again). Right after a hide, "<Title> hidden · Undo"
 * stands in its place for a few seconds; Undo puts it back through the same
 * server setting.
 *
 * A glance may also send a card (a figure, a quiet line, a short run of
 * numbers, a foot). The first shown glance with one is drawn as a card on the
 * right of the greeting, with the Blob in it, and leaves the date line; with
 * none, the Blob stands there alone. Nothing here knows a plugin: a glyph from
 * the pinned set and already formatted text and numbers.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type HomeGlance } from '../../api';
import { tileGlyph } from '../../canvas/tileIcons';
import { pluginPageHref } from '../../pages/pageLinks';
import { Button } from '../../ui';
import { Icon } from '../../ui/Icon';

export const HOME_GLANCES_SHOWN = 3;

/** How long "<Title> hidden · Undo" stays after a hide. */
export const GLANCE_UNDO_MS = 8_000;

/** What this page has hidden or put back since the overview was last read. */
export interface GlanceOverrides {
  hiddenHere: ReadonlySet<string>;
  restoredHere: ReadonlySet<string>;
}

const NO_OVERRIDES: GlanceOverrides = { hiddenHere: new Set(), restoredHere: new Set() };

function isHidden(glance: HomeGlance, o: GlanceOverrides): boolean {
  if (o.hiddenHere.has(glance.id)) return true;
  return glance.hidden && !o.restoredHere.has(glance.id);
}

/** The ones Home draws: not hidden, the first three. */
export function shownGlances(glances: readonly HomeGlance[] | undefined, overrides: GlanceOverrides = NO_OVERRIDES): HomeGlance[] {
  return (glances ?? []).filter((g) => !isHidden(g, overrides)).slice(0, HOME_GLANCES_SHOWN);
}

/** The glance Home draws as the card: the first shown one that sent a card. */
export function cardGlance(glances: readonly HomeGlance[] | undefined, overrides: GlanceOverrides = NO_OVERRIDES): HomeGlance | null {
  return shownGlances(glances, overrides).find((g) => g.card !== undefined) ?? null;
}

/** Where the glance just hidden was drawn, so its Undo line stands there. */
export type GlanceSpot = 'line' | 'card';

export interface GlanceHiding extends GlanceOverrides {
  /** The glance hidden a moment ago, while its Undo line is up. */
  justHidden: { glance: HomeGlance; spot: GlanceSpot } | null;
  hide: (glance: HomeGlance, spot: GlanceSpot) => void;
  undo: () => void;
}

/**
 * Hide one glance: gone at once, remembered by the server, back if the save
 * fails. For `GLANCE_UNDO_MS` (or until the page goes) an Undo line offers it
 * back, through the same setting Settings → Appearance writes. The page
 * re-reads the overview after either.
 */
export function useGlanceHiding(onChanged?: () => void): GlanceHiding {
  const [hiddenHere, setHiddenHere] = useState<Set<string>>(new Set());
  const [restoredHere, setRestoredHere] = useState<Set<string>>(new Set());
  const [justHidden, setJustHidden] = useState<GlanceHiding['justHidden']>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const add = (set: Set<string>, id: string): Set<string> => new Set(set).add(id);
  const drop = (set: Set<string>, id: string): Set<string> => {
    const next = new Set(set);
    next.delete(id);
    return next;
  };

  useEffect(() => {
    if (!justHidden) return undefined;
    const timer = window.setTimeout(() => setJustHidden(null), GLANCE_UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [justHidden]);

  const hide = (glance: HomeGlance, spot: GlanceSpot): void => {
    setHiddenHere((current) => add(current, glance.id));
    setRestoredHere((current) => drop(current, glance.id));
    setJustHidden({ glance, spot });
    void api.setGlanceHidden(glance.id, true).then(() => changed.current?.(), () => {
      setHiddenHere((current) => drop(current, glance.id));
      setJustHidden((current) => (current?.glance.id === glance.id ? null : current));
    });
  };

  const undo = (): void => {
    if (!justHidden) return;
    const { glance } = justHidden;
    setJustHidden(null);
    setHiddenHere((current) => drop(current, glance.id));
    setRestoredHere((current) => add(current, glance.id));
    void api.setGlanceHidden(glance.id, false).then(() => changed.current?.(), () => {
      setRestoredHere((current) => drop(current, glance.id));
      setHiddenHere((current) => add(current, glance.id));
    });
  };

  return { hiddenHere, restoredHere, justHidden, hide, undo };
}

/** "<Title> hidden · Undo", where the glance was, while it can still come back. */
export function GlanceUndo({ hiding, spot }: { hiding: GlanceHiding; spot: GlanceSpot }): JSX.Element | null {
  const just = hiding.justHidden;
  if (!just || just.spot !== spot) return null;
  return (
    <span className="home-glance-undo" role="status" aria-live="polite" data-spot={spot}>
      <span>{just.glance.title} hidden</span>
      <span className="home-glance-sep" aria-hidden="true">·</span>
      <Button size="sm" variant="ghost" onClick={hiding.undo}>Undo</Button>
    </span>
  );
}

function hrefOf(glance: HomeGlance): string | null {
  return glance.link ? pluginPageHref(glance.link.plugin, glance.link.page, glance.link.place) : null;
}

export function HomeGlances({
  glances,
  navigate,
  onChanged,
  except,
  hiding,
}: {
  glances: readonly HomeGlance[] | undefined;
  navigate: (route: string) => void;
  /** After a hide is saved: the page re-reads the overview. */
  onChanged?: () => void;
  /** The glance drawn as the card, left off the line. */
  except?: string | undefined;
  /** The page's hiding state, shared with the card; its own when left out. */
  hiding?: GlanceHiding;
}): JSX.Element | null {
  const own = useGlanceHiding(onChanged);
  const h = hiding ?? own;
  const shown = shownGlances(glances, h).filter((g) => g.id !== except);
  const undo = <GlanceUndo hiding={h} spot="line" />;
  if (shown.length === 0 && h.justHidden?.spot !== 'line') return null;
  return (
    <span className="home-glances">
      {h.justHidden?.spot === 'line' ? (
        <span className="home-glance">
          <span className="home-glance-sep" aria-hidden="true">·</span>
          {undo}
        </span>
      ) : null}
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
            <button type="button" className="home-glance-hide" aria-label={`Hide ${glance.title} from Home`} title="Hide from Home" onClick={() => h.hide(glance, 'line')}>
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
  hiding,
}: {
  glance: HomeGlance;
  navigate: (route: string) => void;
  onChanged?: () => void;
  /** The Blob: drawn in the card, or alone once the card is hidden. */
  blob: ReactNode;
  /** The page's hiding state, shared with the date line; its own when left out. */
  hiding?: GlanceHiding;
}): JSX.Element {
  const own = useGlanceHiding(onChanged);
  const h = hiding ?? own;
  const card = glance.card;
  if (!card || isHidden(glance, h)) return <>{hiding ? null : <GlanceUndo hiding={h} spot="card" />}{blob}</>;
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
      <button type="button" className="home-weather-hide" aria-label={`Hide ${glance.title} from Home`} title="Hide from Home" onClick={() => h.hide(glance, 'card')}>
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}
