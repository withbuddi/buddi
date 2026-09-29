/**
 * The glances beside Home's date: "Monday, 28 September · ☁ 18°C Lyon".
 *
 * At most three, in plugin order, each a quiet link to its plugin's page, with
 * a small × that shows on hover or focus and hides it for good (Settings →
 * Appearance shows it again). Nothing here knows a plugin: a glyph from the
 * pinned set and a line of already formatted text.
 */
import { useState } from 'react';
import { api, type HomeGlance } from '../../api';
import { tileGlyph } from '../../canvas/tileIcons';
import { pluginPageHref } from '../../pages/pageLinks';
import { Icon } from '../../ui/Icon';

export const HOME_GLANCES_SHOWN = 3;

/** The ones Home draws: not hidden, the first three. */
export function shownGlances(glances: readonly HomeGlance[] | undefined, hiddenHere: ReadonlySet<string> = new Set()): HomeGlance[] {
  return (glances ?? []).filter((g) => !g.hidden && !hiddenHere.has(g.id)).slice(0, HOME_GLANCES_SHOWN);
}

export function HomeGlances({
  glances,
  navigate,
  onChanged,
}: {
  glances: readonly HomeGlance[] | undefined;
  navigate: (route: string) => void;
  /** After a hide is saved: the page re-reads the overview. */
  onChanged?: () => void;
}): JSX.Element | null {
  const [hiddenHere, setHiddenHere] = useState<Set<string>>(new Set());
  const shown = shownGlances(glances, hiddenHere);
  if (shown.length === 0) return null;
  const hide = (glance: HomeGlance): void => {
    // Gone at once; the server remembers it for next time.
    setHiddenHere((current) => new Set(current).add(glance.id));
    void api.setGlanceHidden(glance.id, true).then(() => onChanged?.(), () => {
      setHiddenHere((current) => {
        const next = new Set(current);
        next.delete(glance.id);
        return next;
      });
    });
  };
  return (
    <span className="home-glances">
      {shown.map((glance) => {
        const href = glance.link ? pluginPageHref(glance.link.plugin, glance.link.page, glance.link.place) : null;
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
