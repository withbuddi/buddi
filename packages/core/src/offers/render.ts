/**
 * How offered actions are drawn, derived from the surface profile.
 *
 * The temptation was a switch on the surface id — buttons for Telegram, chips
 * for the web, a sentence for the terminal. That is the mistake `surfaces.ts`
 * was written to stop: a surface already declares whether the owner can tap
 * something (`buttons`), and that single fact decides this. A fifth surface
 * gets correct rendering by declaring what it is, not by being added here.
 *
 * So there is exactly one branch, and it reads a fact rather than a name:
 *
 *   buttons: true   -> hand the surface the offers; it draws its own control
 *   buttons: false  -> say them in words, appended to the report's text
 *
 * The words matter. On a surface with nothing to tap, "Draft a reply" is not an
 * instruction the owner can follow by tapping — so it is phrased as what it
 * actually is: a sentence they can ask for.
 */
import type { SurfaceProfile } from '../surfaces.js';
import type { Offer, OfferedAction } from './types.js';

/** The line that introduces the spelled-out form. */
export const OFFERS_PREAMBLE = 'You can ask me to:';

export interface RenderedOffers {
  /** The report text, with the offers appended when they had to be words. */
  text: string;
  /**
   * The offers the surface should draw as controls, or empty when it has none
   * to draw. A surface that gets these must render every one of them.
   */
  controls: readonly Offer[];
}

/**
 * Render a report plus its offers for one surface.
 *
 * Total: a caller passes the result straight to its transport. It never has to
 * ask what kind of surface it is.
 */
export function renderOffers(
  profile: SurfaceProfile,
  text: string,
  offers: readonly Offer[],
): RenderedOffers {
  const body = text.trim();
  if (offers.length === 0) return { text: body, controls: [] };
  if (profile.buttons) return { text: body, controls: offers };
  const lines = offers.map((offer) => `- ${offer.label}`);
  return { text: [body, '', OFFERS_PREAMBLE, ...lines].join('\n'), controls: [] };
}

/**
 * The same thing for offers that have not been stored yet — used by previews
 * and by the inline CLI path, which never persists a button nobody can tap.
 */
export function describeOffers(
  profile: SurfaceProfile,
  text: string,
  actions: readonly OfferedAction[],
): string {
  const body = text.trim();
  if (actions.length === 0 || profile.buttons) return body;
  return [body, '', OFFERS_PREAMBLE, ...actions.map((a) => `- ${a.label}`)].join('\n');
}
