/**
 * A workbook's look, read lightly: `styles.xml` (number formats, fonts,
 * fills, borders, the cell formats `<c s="n">` points at, and the formats
 * conditional rules apply) with `theme1.xml`'s colour slots and tints,
 * resolved into one plain `CellStyle` per cell format. What the preview
 * draws and the render summary counts; fonts' families and sizes are read
 * but a preview keeps its own table font.
 */
import { attr, boolAttr, numAttr } from './xml.js';

export type BorderWeight = 'thin' | 'medium' | 'thick';

export interface BorderEdge {
  /** Drawn as a hairline, 1 px or 2 px; dashes and doubles are drawn as their weight. */
  weight: BorderWeight;
  color?: string;
}

/** One cell format, resolved: every colour `#RRGGBB`. */
export interface CellStyle {
  /** The number format's code: `General`, `#,##0.00`, `d mmm yyyy`… */
  numFmt: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** The font colour, when the format names one. */
  color?: string;
  /** The solid fill. */
  fill?: string;
  fontName?: string;
  fontSize?: number;
  border?: { top?: BorderEdge; right?: BorderEdge; bottom?: BorderEdge; left?: BorderEdge };
  align?: 'left' | 'center' | 'right' | 'justify';
  valign?: 'top' | 'center' | 'bottom';
  wrap?: boolean;
  indent?: number;
}

export interface StyleSheet {
  /** By the cell's `s`. Index 0 is the default format. */
  cells: CellStyle[];
  /** By a conditional rule's `dxfId`: only what the rule changes. */
  dxfs: Array<Partial<CellStyle>>;
}

/** Excel's built-in number formats by id, for the ids a file uses without writing them out. */
export const BUILTIN_FORMATS: Readonly<Record<number, string>> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?',
  13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0',
  48: '##0.0E+0', 49: '@',
};

/** The Office theme's colours, for a workbook that has no theme part (write-excel-file writes none). */
const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

/** The legacy palette `indexed="n"` names. */
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

/**
 * The theme's colour slots in the order `theme="n"` counts them. The file
 * lists dark 1, light 1, dark 2, light 2; a cell's index swaps each pair.
 */
export function readTheme(xml: string | undefined): string[] {
  if (!xml) return DEFAULT_THEME;
  const scheme = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(xml)?.[0];
  if (!scheme) return DEFAULT_THEME;
  const slot = (name: string, fallback: string): string => {
    const body = new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`).exec(scheme)?.[1] ?? '';
    const hex = (v: string | null): string | undefined => (v !== null && /^[0-9A-Fa-f]{6}$/.test(v) ? v : undefined);
    const srgb = hex(attr(/<a:srgbClr\b([^>]*)\/?>/.exec(body)?.[1] ?? '', 'val'));
    const sys = hex(attr(/<a:sysClr\b([^>]*)\/?>/.exec(body)?.[1] ?? '', 'lastClr'));
    return (srgb ?? sys ?? fallback).toUpperCase();
  };
  const names = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  return names.map((name, i) => slot(name, DEFAULT_THEME[i]!));
}

/** A colour lightened or darkened by a tint (−1 … 1), the way Excel applies one: on its lightness. */
export function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const n = parseInt(hex, 16);
  let r = ((n >> 16) & 255) / 255;
  let g = ((n >> 8) & 255) / 255;
  let b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number): number => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  if (s === 0) { r = g = b = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
  }
  const part = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/** A `<color>`-like tag's colour as `#RRGGBB`, or undefined for automatic and the system colours. */
function colorOf(tag: string | undefined, theme: string[]): string | undefined {
  if (!tag) return undefined;
  if (boolAttr(tag, 'auto')) return undefined;
  const rgb = attr(tag, 'rgb');
  const tint = numAttr(tag, 'tint') ?? 0;
  let hex: string | undefined;
  if (rgb && /^[0-9A-Fa-f]{6,8}$/.test(rgb)) hex = rgb.slice(-6).toUpperCase();
  const themeIndex = numAttr(tag, 'theme');
  if (hex === undefined && themeIndex !== null) hex = theme[themeIndex];
  const indexed = numAttr(tag, 'indexed');
  if (hex === undefined && indexed !== null) hex = INDEXED[indexed];
  return hex === undefined ? undefined : `#${applyTint(hex, tint)}`;
}

const WEIGHT: Record<string, BorderWeight> = {
  hair: 'thin', thin: 'thin', dotted: 'thin', dashed: 'thin', dashDot: 'thin', dashDotDot: 'thin',
  medium: 'medium', mediumDashed: 'medium', mediumDashDot: 'medium', mediumDashDotDot: 'medium', slantDashDot: 'medium',
  thick: 'thick', double: 'thick',
};

interface Font { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; color?: string; fontName?: string; fontSize?: number }

function readFont(xml: string, theme: string[]): Font {
  const flag = (name: string): boolean | undefined => {
    const tag = new RegExp(`<${name}(\\s[^>]*)?/?>`).exec(xml);
    if (!tag) return undefined;
    const val = attr(tag[1] ?? '', 'val');
    return val === null ? true : !(val === '0' || val === 'false' || val === 'none');
  };
  const out: Font = {};
  const bold = flag('b'); if (bold !== undefined) out.bold = bold;
  const italic = flag('i'); if (italic !== undefined) out.italic = italic;
  const underline = flag('u'); if (underline !== undefined) out.underline = underline;
  const strike = flag('strike'); if (strike !== undefined) out.strike = strike;
  const color = colorOf(/<color\b[^>]*\/?>/.exec(xml)?.[0], theme); if (color) out.color = color;
  const name = /<name\b([^>]*)\/?>/.exec(xml)?.[1]; if (name) { const v = attr(name, 'val'); if (v) out.fontName = v; }
  const size = /<sz\b([^>]*)\/?>/.exec(xml)?.[1]; if (size) { const v = numAttr(size, 'val'); if (v) out.fontSize = v; }
  return out;
}

/** A fill's solid colour. A conditional format's solid fill is its background colour; a cell's, its foreground. */
function readFill(xml: string, theme: string[], dxf: boolean): string | undefined {
  const pattern = /<patternFill\b([^>]*)(?:\/>|>([\s\S]*?)<\/patternFill>)/.exec(xml);
  if (pattern) {
    const type = attr(pattern[1] ?? '', 'patternType');
    if (type === 'none' || (type === null && !dxf)) return undefined;
    const fg = colorOf(/<fgColor\b[^>]*\/?>/.exec(pattern[2] ?? '')?.[0], theme);
    const bg = colorOf(/<bgColor\b[^>]*\/?>/.exec(pattern[2] ?? '')?.[0], theme);
    if (type === 'gray125' || type === 'gray0625') return undefined;
    return dxf ? bg ?? fg : fg ?? bg;
  }
  // A gradient: its first stop stands for it.
  const stop = /<stop\b[^>]*>([\s\S]*?)<\/stop>/.exec(xml)?.[1];
  return stop ? colorOf(/<color\b[^>]*\/?>/.exec(stop)?.[0], theme) : undefined;
}

function readBorder(xml: string, theme: string[]): CellStyle['border'] {
  const out: NonNullable<CellStyle['border']> = {};
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const tag = new RegExp(`<${side}\\b([^>]*)(?:/>|>([\\s\\S]*?)</${side}>)`).exec(xml);
    if (!tag) continue;
    const weight = WEIGHT[attr(tag[1] ?? '', 'style') ?? ''];
    if (!weight) continue;
    const color = colorOf(/<color\b[^>]*\/?>/.exec(tag[2] ?? '')?.[0], theme);
    out[side] = color ? { weight, color } : { weight };
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function readAlignment(xml: string): Pick<CellStyle, 'align' | 'valign' | 'wrap' | 'indent'> {
  const tag = /<alignment\b([^>]*)\/?>/.exec(xml)?.[1];
  if (!tag) return {};
  const out: Pick<CellStyle, 'align' | 'valign' | 'wrap' | 'indent'> = {};
  const h = attr(tag, 'horizontal');
  if (h === 'left' || h === 'right' || h === 'justify') out.align = h;
  else if (h === 'center' || h === 'centerContinuous') out.align = 'center';
  const v = attr(tag, 'vertical');
  if (v === 'top' || v === 'bottom') out.valign = v;
  else if (v === 'center') out.valign = 'center';
  if (boolAttr(tag, 'wrapText')) out.wrap = true;
  const indent = numAttr(tag, 'indent');
  if (indent) out.indent = indent;
  return out;
}

function blocks(xml: string, outer: string, inner: string): string[] {
  const body = new RegExp(`<${outer}\\b[^>]*>([\\s\\S]*?)</${outer}>`).exec(xml)?.[1] ?? '';
  return [...body.matchAll(new RegExp(`<${inner}\\b[^>]*?(?:/>|>[\\s\\S]*?</${inner}>)`, 'g'))].map((m) => m[0]);
}

const clean = <T extends object>(value: T): T => {
  for (const key of Object.keys(value) as Array<keyof T>) if (value[key] === undefined) delete value[key];
  return value;
};

/**
 * The workbook's cell formats, resolved, and its conditional formats. Takes
 * the `styles.xml` and `theme1.xml` parts' text; either may be missing.
 */
export function readStyles(stylesXml: string | undefined, themeXml: string | undefined): StyleSheet {
  const theme = readTheme(themeXml);
  const xml = stylesXml ?? '';
  const formats = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = numAttr(m[1]!, 'numFmtId');
    const code = attr(m[1]!, 'formatCode');
    if (id !== null && code !== null) formats.set(id, code);
  }
  const fonts = blocks(xml, 'fonts', 'font').map((f) => readFont(f, theme));
  const fills = blocks(xml, 'fills', 'fill').map((f) => readFill(f, theme, false));
  const borders = blocks(xml, 'borders', 'border').map((b) => readBorder(b, theme));
  const numFmtOf = (id: number | null): string => (id === null ? 'General' : formats.get(id) ?? BUILTIN_FORMATS[id] ?? 'General');

  const cells = blocks(xml, 'cellXfs', 'xf').map((xf): CellStyle => {
    const tag = /<xf\b([^>]*?)\/?>/.exec(xf)?.[1] ?? '';
    const font = fonts[numAttr(tag, 'fontId') ?? 0] ?? {};
    const { fontName, fontSize, ...face } = font;
    const style: CellStyle = {
      numFmt: numFmtOf(numAttr(tag, 'numFmtId')),
      ...face,
      ...(fontName ? { fontName } : {}),
      ...(fontSize ? { fontSize } : {}),
    };
    const fill = fills[numAttr(tag, 'fillId') ?? 0];
    if (fill) style.fill = fill;
    const border = borders[numAttr(tag, 'borderId') ?? 0];
    if (border) style.border = border;
    Object.assign(style, readAlignment(xf));
    if (!style.bold) delete style.bold;
    if (!style.italic) delete style.italic;
    if (!style.underline) delete style.underline;
    if (!style.strike) delete style.strike;
    return style;
  });
  if (cells.length === 0) cells.push({ numFmt: 'General' });

  const dxfs = blocks(xml, 'dxfs', 'dxf').map((dxf): Partial<CellStyle> => {
    const font = /<font\b[^>]*>([\s\S]*?)<\/font>/.exec(dxf)?.[1];
    const fill = /<fill\b[^>]*>[\s\S]*?<\/fill>/.exec(dxf)?.[0];
    const border = /<border\b[^>]*>[\s\S]*?<\/border>/.exec(dxf)?.[0];
    const numFmt = /<numFmt\b([^>]*)\/?>/.exec(dxf)?.[1];
    const { fontName: _n, fontSize: _s, ...face } = font ? readFont(font, theme) : {};
    return clean({
      ...face,
      fill: fill ? readFill(fill, theme, true) : undefined,
      border: border ? readBorder(border, theme) : undefined,
      numFmt: numFmt ? attr(numFmt, 'formatCode') || undefined : undefined,
    });
  });
  return { cells, dxfs };
}
