/**
 * buddi's own line icons, in one place.
 *
 * Every glyph the shell, the composer, the thread and the canvas draw, copied
 * path for path from where each was drawn inline: the same grid, the same
 * stroke, the same size on the page, so moving them here changes no pixel.
 * Round caps and joins, `currentColor`, no fills — except the settings
 * sliders' knobs, which are punched out in the surface colour.
 *
 * The design system's `assets/icons/*.svg` and its `Icon` are the same set;
 * a glyph that is not here is drawn in the same hand (20px grid for a place,
 * 11–16 for an inline mark, stroke 1.3–1.8) and added here, never pulled in
 * from an icon font or an image. An icon is decoration: the word next to it,
 * or the control's own label, says what it is.
 */
import type { SVGAttributes } from 'react';

/** grid (the viewBox side), stroke width, the drawing, and its size on the page when it differs from the grid. */
type Glyph = readonly [grid: number, stroke: number, body: JSX.Element, size?: number];

const GLYPHS = {
  // ---- places: the rail, on a 20px grid ----
  home: [20, 1.6, <><path d="M3.5 9.2 10 3.6l6.5 5.6" /><path d="M5.2 8.4v7.4a1 1 0 0 0 1 1h2.6v-4.6h2.4v4.6h2.6a1 1 0 0 0 1-1V8.4" /></>],
  chat: [20, 1.6, <><path d="M17 10.6a4.9 4.9 0 0 1-4.9 4.9H7.8L3.6 18l.9-3A4.9 4.9 0 0 1 3 11V8.2A4.9 4.9 0 0 1 7.9 3.3h4.2A4.9 4.9 0 0 1 17 8.2Z" /><path d="M7 8.3h6M7 11.3h3.6" /></>],
  agents: [20, 1.6, <><circle cx="7.5" cy="7" r="2.8" /><path d="M2.8 16.2a4.7 4.7 0 0 1 9.4 0" /><circle cx="14" cy="7.8" r="2.2" /><path d="M13.2 12.5a3.9 3.9 0 0 1 4.3 3.7" /></>],
  activity: [20, 1.6, <path d="M2.8 10.5h3.4l2-5.2 3.4 9.8 2.2-4.6h3.4" />],
  settings: [20, 1.6, <><path d="M3 5.5h14M3 10h14M3 14.5h14" /><circle cx="7.5" cy="5.5" r="1.7" fill="var(--surface)" /><circle cx="12.5" cy="10" r="1.7" fill="var(--surface)" /><circle cx="6.5" cy="14.5" r="1.7" fill="var(--surface)" /></>],
  // Two sheets, the front one with a folded corner.
  files: [20, 1.6, <><path d="M7.5 2.8h5.2L16.5 6.6v8.6a1.2 1.2 0 0 1-1.2 1.2H7.5a1.2 1.2 0 0 1-1.2-1.2V4a1.2 1.2 0 0 1 1.2-1.2z" /><path d="M12.7 2.8v3.8h3.8" /><path d="M4.4 6.2v9.4a1.6 1.6 0 0 0 1.6 1.6h6.6" /></>],
  // An envelope, the flap drawn as the fold.
  mail: [20, 1.6, <><rect x="3" y="5" width="14" height="10.5" rx="1.4" /><path d="M3.4 6 10 11l6.6-5" /></>],
  money: [20, 1.6, <><rect x="2.6" y="5.2" width="14.8" height="9.6" rx="1.6" /><circle cx="10" cy="10" r="2.2" /><path d="M5.4 10h.5M14.1 10h.5" /></>],
  calendar: [20, 1.6, <><rect x="3" y="4.4" width="14" height="12.2" rx="1.6" /><path d="M3 8.2h14M6.8 2.9v2.6M13.2 2.9v2.6" /></>],
  chart: [20, 1.6, <path d="M3.2 16.4V8.6M8.4 16.4V3.9M13.6 16.4v-5.8M3.2 16.4h13.6" />],
  bell: [20, 1.6, <><path d="M5.4 13.6V9a4.6 4.6 0 0 1 9.2 0v4.6l1.2 1.7H4.2Z" /><path d="M8.4 17.1a1.8 1.8 0 0 0 3.2 0" /></>],
  plug: [20, 1.6, <><path d="M7.4 2.8v3.4M12.6 2.8v3.4" /><path d="M5 6.2h10v3.1a5 5 0 0 1-10 0Z" /><path d="M10 14.3v3" /></>],
  key: [20, 1.6, <><circle cx="6.6" cy="10" r="3.2" /><path d="M9.8 10h7.2M14.4 10v2.6M16.6 10v1.8" /></>],
  globe: [20, 1.6, <><circle cx="10" cy="10" r="7.1" /><path d="M2.9 10h14.2M10 2.9c3.4 3.7 3.4 10.5 0 14.2-3.4-3.7-3.4-10.5 0-14.2Z" /></>],

  // ---- the composer ----
  clip: [17, 1.5, <path d="M13.2 8 8.4 12.8a3 3 0 0 1-4.2-4.2l5.1-5.1a2 2 0 1 1 2.8 2.8l-5 5" />],
  // Up, not right: the message leaves the box and goes to the thread above.
  send: [16, 1.8, <path d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2" />],

  // ---- the thread ----
  thought: [13, 1.4, <><path d="M4.2 9.6a3.6 3.6 0 1 1 4.6 0v1.2H4.2z" /><path d="M5.2 12.2h2.6" /></>],
  chevron: [11, 1.5, <path d="M2.8 4.2 5.5 6.9l2.7-2.7" />],
  arrow: [13, 1.5, <path d="M4.8 2.6 9 6.5l-4.2 3.9" />],

  // ---- the roster ----
  // A struck-through circle: out of service, not merely quiet.
  out: [12, 1.6, <><circle cx="6" cy="6" r="4.4" /><path d="M3.4 8.6 8.6 3.4" /></>, 11],
  'chevron-left': [14, 1.6, <path d="M9 2.5 4.5 7 9 11.5" />],
  'chevron-right': [14, 1.6, <path d="M5 2.5 9.5 7 5 11.5" />],
  plus: [14, 1.6, <path d="M7 2.5v9M2.5 7h9" />],

  // ---- the canvas ----
  'chevron-down': [14, 1.4, <path d="M4 5.5 7 8.5l3-3" />, 12],
  // An empty frame with a hill and a sun: where a result will be drawn.
  frame: [22, 1.3, <><rect x="2.6" y="3.6" width="16.8" height="14.8" rx="2" /><path d="M2.6 14.2 7.4 9.6l3.4 3 3-2.6 3.6 3.2" /><circle cx="7.4" cy="7.6" r="1.2" /></>],
  // Each renderer drawn as the mark it makes.
  'shape-timeseries': [16, 1.4, <path d="M2 11.5 5.4 7.2l2.6 2.2L14 3.5" />],
  'shape-table': [16, 1.4, <path d="M2.2 3.5h11.6v9H2.2zM2.2 6.6h11.6M6.6 6.6v5.9" />],
  'shape-bars': [16, 1.4, <path d="M3 13V8.2M7 13V3.6M11 13V6.4M2 13.6h12" />],
  'shape-keyvalue': [16, 1.4, <path d="M2.6 4.6h4M9.4 4.6h4M2.6 8h4M9.4 8h4M2.6 11.4h4M9.4 11.4h4" />],
  'shape-document': [16, 1.4, <path d="M4 2.4h5l3 3v8.2H4zM9 2.4v3h3M6 9h4M6 11.2h3" />],
  // A plus over a minus: lines in, lines out.
  'shape-diff': [16, 1.4, <path d="M8 2.6v5M5.5 5.1h5M5.5 11.6h5M3 14h10" />],
  // A prompt and a cursor.
  'shape-terminal': [16, 1.4, <path d="M2.2 3.4h11.6v9.2H2.2zM4.6 6.4l2 1.6-2 1.6M8 10h3" />],
  // A frame with a hill and a sun.
  'shape-image': [16, 1.4, <path d="M2.2 3.4h11.6v9.2H2.2zM2.2 11l3.6-3.4 2.6 2.4 2-1.8 3.4 3M10.6 6.2h.01" />],
  // A window with a title bar: the app itself, framed.
  'shape-preview': [16, 1.4, <path d="M2.2 3.4h11.6v9.2H2.2zM2.2 6h11.6M4.1 4.7h.01M6 4.7h.01" />],
  'shape-envelope': [16, 1.4, <path d="M2.2 4h11.6v8H2.2zM2.2 4.4 8 8.8l5.8-4.4" />],
  'shape-structured': [16, 1.4, <path d="M4 2.6h8v10.8H4zM6.2 5.6h3.6M6.2 8h3.6M6.2 10.4h2.2" />],
} satisfies Record<string, Glyph>;

export type IconName = keyof typeof GLYPHS;

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];

/**
 * One of buddi's icons, at its own size unless `size` says otherwise.
 * Always `aria-hidden`: the label belongs to the control around it.
 */
export function Icon({
  name,
  size,
  className,
  ...rest
}: { name: IconName; size?: number; className?: string } & Omit<SVGAttributes<SVGSVGElement>, 'children' | 'style'>): JSX.Element {
  const [grid, stroke, body, drawn] = GLYPHS[name] as Glyph;
  const px = size ?? drawn ?? grid;
  return (
    <svg
      className={className}
      width={px}
      height={px}
      viewBox={`0 0 ${grid} ${grid}`}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      {...rest}
    >
      {body}
    </svg>
  );
}
