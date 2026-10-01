/**
 * The glyph each pinned tile icon is drawn with. Shared by the `tiles`
 * renderer and Home's glances; anything outside the set is the neutral dot.
 */
import type { IconName } from '../ui/Icon';
import type { TileIcon } from './types';

const TILE_GLYPHS: Record<TileIcon, IconName> = {
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
  sun: 'sun',
  'partly-cloudy': 'partly-cloudy',
  cloud: 'cloud',
  rain: 'rain',
  drizzle: 'drizzle',
  snow: 'snow',
  storm: 'storm',
  fog: 'fog',
  wind: 'wind',
  'moon-clear': 'moon-clear',
  check: 'check',
  clock: 'clock',
};

export function tileGlyph(icon: string | null | undefined): IconName {
  return (icon && Object.prototype.hasOwnProperty.call(TILE_GLYPHS, icon) ? TILE_GLYPHS[icon as TileIcon] : undefined) ?? 'dot';
}
