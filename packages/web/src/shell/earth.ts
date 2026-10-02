/**
 * Earth, the lock screen's default background: a photo that ships in the
 * bundle ("outer space photography of earth" by ActionVance on Unsplash, the
 * Unsplash License — `earth/ATTRIBUTION.md`). Imported, so Vite hashes the
 * files and the gateway caches them for good; the service worker's precache
 * leaves them out (it keeps only the shell).
 *
 * A desk gets the whole frame at 2560 pixels; a phone gets its own portrait
 * crop around the curve, so a tall screen is not a blurry sliver of a wide one.
 */
import desk from './earth/earth-2560.webp';
import phone from './earth/earth-phone.webp';
import thumb from './earth/earth-thumb.webp';

export const EARTH_PHOTO = { desk, phone, thumb } as const;

/** Where the photo comes from, said under the background swatches. */
export const EARTH_CREDIT = {
  author: 'ActionVance',
  authorUrl: 'https://unsplash.com/@actionvance',
  photoUrl: 'https://unsplash.com/photos/outer-space-photography-of-earth-t7EL2iG3jMc',
} as const;

/** The picture for the screen the lock face is drawn for. */
export function earthSource(isPhone: boolean): string {
  return isPhone ? EARTH_PHOTO.phone : EARTH_PHOTO.desk;
}
