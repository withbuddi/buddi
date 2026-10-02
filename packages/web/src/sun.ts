/**
 * Is the sun up at a place? A small solar position (the low-precision
 * formulas of the Astronomical Almanac, good to a fraction of a degree, so a
 * few minutes around sunrise and sunset) — no dependency, no network.
 *
 * Day is the sun's centre above −0.833°: the standard sunrise and sunset,
 * which count refraction and the sun's radius. Polar day and polar night
 * fall out of it with no special case.
 */

const RAD = Math.PI / 180;

/** The sun's elevation above the horizon in degrees, at `at`, seen from `latitude`, `longitude`. */
export function solarElevation(at: Date, latitude: number, longitude: number): number {
  const d = at.getTime() / 86_400_000 + 2_440_587.5 - 2_451_545.0; // days from J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude, degrees
  const lambda = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD; // ecliptic longitude
  const epsilon = (23.439 - 0.00000036 * d) * RAD; // obliquity
  const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  const decl = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15; // degrees
  const hourAngle = (gmst + longitude) * RAD - ra;
  const phi = latitude * RAD;
  const sinAlt = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD;
}

/** Between sunrise and sunset there. */
export function sunIsUp(at: Date, latitude: number, longitude: number): boolean {
  return solarElevation(at, latitude, longitude) > -0.833;
}
