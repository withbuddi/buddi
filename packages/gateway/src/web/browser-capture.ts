/**
 * Capture's name in Files: the page's title and when it was taken, in the
 * owner's zone ("Your orders 2026-10-07 14.32.png"). A page with no title is
 * named after its site. Nothing a file system refuses, and no longer than a
 * name in a list can show.
 */
export function captureFilename(input: { title: string; url: string; at: Date; timezone: string }): string {
  let site = '';
  try { site = new URL(input.url).hostname.replace(/^www\./, ''); } catch { /* an app window, an odd address */ }
  const base = (input.title.trim() || site || 'Page')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: input.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(input.at).map((part) => [part.type, part.value]));
  return `${base || 'Page'} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}.${parts.minute}.png`;
}
