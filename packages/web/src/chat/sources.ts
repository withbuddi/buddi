/**
 * The web tools whose calls the canvas gathers into one Sources tab per turn.
 *
 * This is the one page module that names them, in the way `browser.ts` names
 * the browser's: the canvas package is handed the set and still knows the
 * name of no tool. The panel itself reads shapes — a URL and its text, a
 * query and its results — never these names.
 */
export const WEB_READ = 'web.read';
export const WEB_SEARCH = 'web.search';

export const WEB_SOURCE_TOOLS: ReadonlySet<string> = new Set([WEB_READ, WEB_SEARCH]);
