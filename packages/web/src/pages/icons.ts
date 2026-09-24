/**
 * The pinned icon set a plugin page may ask for, as the glyph each is drawn
 * with.
 *
 * Drawn by the shell, in the same hand as the core places, and never an image
 * the plugin supplies: a rail of twenty strangers' logos is not a rail. A page
 * that names none of them gets the plug. The rail and the Settings list both
 * read this, so a plugin's page wears the same icon in either place.
 */
import type { IconName } from '../ui/Icon';
import type { PageIcon } from './types';

export const PAGE_ICONS: Record<PageIcon, IconName> = {
  mail: 'mail',
  money: 'money',
  calendar: 'calendar',
  people: 'agents',
  file: 'files',
  chart: 'chart',
  bell: 'bell',
  plug: 'plug',
  key: 'key',
  globe: 'globe',
};

/** The glyph a descriptor's icon is drawn with; the plug when it names none. */
export function pageIcon(icon: PageIcon | undefined): IconName {
  return (icon && PAGE_ICONS[icon]) || 'plug';
}
