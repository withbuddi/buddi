import { useEffect, useState } from 'react';

/**
 * The width below which the canvas stops being a column and becomes a sheet,
 * and the Settings list folds into a menu at the top of its section.
 */
export const NARROW_QUERY = '(max-width: 900px)';

/** A media query as state, degrading to "wide" where `matchMedia` is absent. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let list: MediaQueryList;
    try {
      list = window.matchMedia(query);
    } catch {
      return undefined;
    }
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}
