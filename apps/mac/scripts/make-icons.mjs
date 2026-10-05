#!/usr/bin/env node
// buddi's icons, drawn from the Buddi Blob vector rig: one mark wherever an icon
// stands alone (the "b" lettermark lives only inside the wordmark).
//
//   node apps/mac/scripts/make-icons.mjs [path/to/buddi-blob-core.svg]   the Mac app
//   node apps/mac/scripts/make-icons.mjs --web --extension --site[=dir]  the browser sets
//   node apps/mac/scripts/make-icons.mjs all [--site=dir]                every target
//
// With a path, that rig (buddi-design/mascot/rig/buddi-blob-core.svg) replaces the
// copy in Design/ first; without one, the committed copy is used. It writes:
//
//   mac (the default, and part of `all`)
//   Design/app-icon.svg              the dock icon's composition (macOS grid, kit ground)
//   Design/status-glyph*.svg         the menu-bar glyph, one per state
//   Resources/Assets.xcassets/AppIcon.appiconset/icon_*.png   16 … 1024
//   Resources/Assets.xcassets/StatusGlyph*.imageset/*.png     18 pt, @1x and @2x, template
//
//   --web        packages/web/public: favicon.ico (16/32/48), favicon-16.png, favicon-32.png,
//                apple-touch-icon.png (180, the dock composition squared off), icon-192.png
//                and icon-512.png (the dock tile), maskable-512.png (80 % safe zone)
//   --extension  packages/extension/static/icons/{16,32,48,128}.png
//   --site[=dir] the web set plus og-image.png (1200×630) into <dir>/public; dir defaults
//                to buddi-site beside this repository, and `all` skips it when absent
//   Design/favicon-*.svg, icon-*.svg, og-image.svg   the sources of the browser sets
//
// Small sizes use the bolder cut the menu-bar glyph uses (bigger eyes, a bigger coral
// tip, no mouth or feet), so the Blob still reads in a 16 px browser tab.
//
// Rendering is resvg (@resvg/resvg-js, pinned to RESVG_VERSION and installed with
// --ignore-scripts), installed once into ~/Library/Caches/buddi-make-icons when it
// cannot be imported from here. The og image's wordmark is the kit's DM Sans, decoded
// from the extension's woff2 by wawoff2 (WAWOFF2_VERSION, same cache); without it
// the image carries no text. apps/mac has no package.json of its own, so the pins
// live here; a cached copy of another version is replaced.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const mac = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(mac, '../..');
const designDir = join(mac, 'Design');
const assets = join(mac, 'Resources/Assets.xcassets');
const rigPath = join(designDir, 'buddi-blob-core.svg');

const args = process.argv.slice(2);
const all = args.includes('all');
const siteArg = args.find((a) => a === '--site' || a.startsWith('--site='));
const rigArg = args.find((a) => !a.startsWith('-') && a !== 'all' && a !== 'mac');
const targets = {
  mac: all || args.includes('mac') || !args.some((a) => a.startsWith('--')),
  web: all || args.includes('--web'),
  extension: all || args.includes('--extension'),
  site: Boolean(siteArg) || all,
};
const siteDir = siteArg?.startsWith('--site=') ? resolve(siteArg.slice('--site='.length)) : resolve(repo, '../buddi-site');

if (rigArg) {
  mkdirSync(designDir, { recursive: true });
  copyFileSync(resolve(rigArg), rigPath);
}
const rig = readFileSync(rigPath, 'utf8');

// ---- the rig ---------------------------------------------------------------

/** The rig's drawing, without its <svg> wrapper (ids prefixed so they cannot collide). */
const rigBody = rig
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/id="/g, 'id="rig-')
  .trim();

function attr(id, name) {
  const tag = rig.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`));
  if (!tag) throw new Error(`the rig has no #${id}`);
  const value = tag[0].match(new RegExp(`\\b${name}="([^"]*)"`));
  if (!value) throw new Error(`#${id} has no ${name}`);
  return value[1];
}
const num = (id, name) => Number(attr(id, name));

const shape = {
  silhouette: attr('silhouette', 'd'),
  armL: attr('armL', 'd'),
  armR: attr('armR', 'd'),
  antenna: { cx: num('antenna', 'cx'), cy: num('antenna', 'cy'), r: num('antenna', 'r') },
  colour: { body: attr('silhouette', 'fill'), tip: attr('antenna', 'fill'), white: attr('eyeL-white', 'fill') },
  pupils: ['eyeL-pupil', 'eyeR-pupil'].map((id) => {
    const group = rig.match(new RegExp(`<g id="${id}">\\s*<ellipse([^>]*)>`));
    if (!group) throw new Error(`the rig has no ellipse in #${id}`);
    const value = (name) => Number(group[1].match(new RegExp(`\\b${name}="([^"]*)"`))[1]);
    return { cx: value('cx'), cy: value('cy'), rx: value('rx'), ry: value('ry'), fill: group[1].match(/fill="([^"]*)"/)[1] };
  }),
  eyes: ['eyeL-white', 'eyeR-white'].map((id) => ({
    cx: num(id, 'cx'), cy: num(id, 'cy'), rx: num(id, 'rx'), ry: num(id, 'ry'),
  })),
};

// ---- the app icon ----------------------------------------------------------

// Apple's macOS icon grid on a 1024 canvas: an 824 body inset by 100, corner
// radius ≈ 22.4 % of the side with continuous (squircle) corners.
const GRID = { x: 100, y: 100, size: 824 };

/** Continuous-corner rounded rect (the iOS 7 / macOS squircle bezier approximation). */
function squircle(x, y, w, h, r) {
  const X = x + w, Y = y + h;
  const k = [1.52866483, 1.08849323, 0.86840689, 0.63149399, 0.07491100, 0.37282392, 0.16905899];
  const [a, b, c, d, e, f, g] = k.map((v) => v * r);
  const p = (n) => +n.toFixed(2);
  return [
    `M${p(x + a)} ${p(y)}`,
    `L${p(X - a)} ${p(y)}`,
    `C${p(X - b)} ${p(y)} ${p(X - c)} ${p(y)} ${p(X - d)} ${p(y + e)}`,
    `C${p(X - f)} ${p(y + g)} ${p(X - g)} ${p(y + f)} ${p(X - e)} ${p(y + d)}`,
    `C${p(X)} ${p(y + c)} ${p(X)} ${p(y + b)} ${p(X)} ${p(y + a)}`,
    `L${p(X)} ${p(Y - a)}`,
    `C${p(X)} ${p(Y - b)} ${p(X)} ${p(Y - c)} ${p(X - e)} ${p(Y - d)}`,
    `C${p(X - g)} ${p(Y - f)} ${p(X - f)} ${p(Y - g)} ${p(X - d)} ${p(Y - e)}`,
    `C${p(X - c)} ${p(Y)} ${p(X - b)} ${p(Y)} ${p(X - a)} ${p(Y)}`,
    `L${p(x + a)} ${p(Y)}`,
    `C${p(x + b)} ${p(Y)} ${p(x + c)} ${p(Y)} ${p(x + d)} ${p(Y - e)}`,
    `C${p(x + f)} ${p(Y - g)} ${p(x + g)} ${p(Y - f)} ${p(x + e)} ${p(Y - d)}`,
    `C${p(x)} ${p(Y - c)} ${p(x)} ${p(Y - b)} ${p(x)} ${p(Y - a)}`,
    `L${p(x)} ${p(y + a)}`,
    `C${p(x)} ${p(y + b)} ${p(x)} ${p(y + c)} ${p(x + e)} ${p(y + d)}`,
    `C${p(x + g)} ${p(y + f)} ${p(x + f)} ${p(y + g)} ${p(x + d)} ${p(y + e)}`,
    `C${p(x + c)} ${p(y)} ${p(x + b)} ${p(y)} ${p(x + a)} ${p(y)}`,
    'Z',
  ].join(' ');
}

// The kit's page ground (design-system/tokens/colors.css, --gradient-page, light):
// a #e9f1fd → #f3f5f8 wash under blue (field-a, field-c) and sand (field-b) glows
// at 55 % / 55 % / 45 %.
const PAGE = {
  top: '#e9f1fd', bottom: '#f3f5f8',
  glows: [
    { color: '#8fbcfb', opacity: 0.55, at: [0.85, -0.15], size: [0.75, 0.60] },
    { color: '#f3d6a9', opacity: 0.55, at: [1.00, 1.05], size: [0.55, 0.50] },
    { color: '#b9d4fb', opacity: 0.45, at: [-0.05, 0.60], size: [0.50, 0.45] },
  ],
};

// Head and upper body: the blob scaled up, centred on its body (arms included),
// the coral tip below the top edge, the rest running off the bottom of the tile.
const FRAME = { scale: 1.12, centreX: 518, antennaTop: 196 };

/** The kit's page ground over a w × h box at (x, y): a wash and three glows, as CSS lays them out. */
function pageGround(x, y, w, h) {
  const defs = PAGE.glows.map((g, i) => {
    const cx = x + g.at[0] * w, cy = y + g.at[1] * h;
    const rx = g.size[0] * w, ry = g.size[1] * h;
    return `<radialGradient id="glow${i}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${rx}" gradientTransform="translate(${cx} ${cy}) scale(1 ${ry / rx}) translate(${-cx} ${-cy})">
      <stop offset="0" stop-color="${g.color}" stop-opacity="${g.opacity}"/>
      <stop offset="0.7" stop-color="${g.color}" stop-opacity="0"/>
    </radialGradient>`;
  });
  const wash = `<linearGradient id="wash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PAGE.top}"/>
      <stop offset="1" stop-color="${PAGE.bottom}"/>
    </linearGradient>`;
  const rects = [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#wash)"/>`,
    ...PAGE.glows.map((_, i) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#glow${i})"/>`),
  ];
  return { wash, glows: defs, rects };
}

const BLOB_SHADOW = `<filter id="blobShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#152642" flood-opacity="0.18"/>
    </filter>`;

/**
 * The dock composition. `tile` (the default) is the macOS icon: the squircle on a
 * transparent 1024 canvas with its shadow. `bleed` is the same picture squared off
 * to the grid (apple-touch-icon: iOS rounds it itself). `maskable` is the bleed with
 * the Blob shrunk about the centre so the tip and face sit inside the 80 % safe
 * zone a launcher's mask keeps.
 */
function appIconSvg(variant = 'tile') {
  const { x, y, size } = GRID;
  const r = size * 0.224;
  const tile = squircle(x, y, size, size, r);
  const top = shape.antenna.cy - shape.antenna.r;
  const s = FRAME.scale;
  const tx = 512 - FRAME.centreX * s;
  const ty = FRAME.antennaTop - top * s;
  const ground = pageGround(x, y, size, size);
  const blob = `<g filter="url(#blobShadow)">
      <g transform="translate(${+tx.toFixed(2)} ${+ty.toFixed(2)}) scale(${s})">
        ${rigBody.replace(/\n/g, '\n        ')}
      </g>
    </g>`;
  if (variant !== 'tile') {
    const k = MASKABLE.scale;
    const placed = variant === 'maskable'
      ? `<g transform="translate(512 ${MASKABLE.centreY}) scale(${k}) translate(-512 ${-MASKABLE.centreY})">\n    ${blob}\n    </g>`
      : blob;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!-- buddi icon (${variant}), generated by apps/mac/scripts/make-icons.mjs from Design/buddi-blob-core.svg. Edit the script, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${size} ${size}" width="${size}" height="${size}">
  <defs>
    <clipPath id="square"><rect x="${x}" y="${y}" width="${size}" height="${size}"/></clipPath>
    ${ground.wash}
    ${ground.glows.join('\n    ')}
    ${BLOB_SHADOW}
  </defs>
  <g clip-path="url(#square)">
    ${ground.rects.join('\n    ')}
    ${placed}
  </g>
</svg>
`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- buddi.app icon, generated by apps/mac/scripts/make-icons.mjs from Design/buddi-blob-core.svg. Edit the script, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <clipPath id="tile"><path d="${tile}"/></clipPath>
    ${ground.wash}
    ${ground.glows.join('\n    ')}
    <filter id="tileShadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.28"/>
    </filter>
    ${BLOB_SHADOW}
  </defs>
  <path d="${tile}" fill="${PAGE.bottom}" filter="url(#tileShadow)"/>
  <g clip-path="url(#tile)">
    ${ground.rects.join('\n    ')}
    ${blob}
  </g>
</svg>
`;
}

// The maskable cut: the Blob at this scale about (512, centreY) keeps the coral tip
// and the face inside the safe circle (radius 40 % of the side, about the centre);
// the arms and body still run to the edge, as in the dock tile.
const MASKABLE = { scale: 0.72, centreY: 560 };

// ---- the menu-bar glyph ----------------------------------------------------

// The whole figure's silhouette (body, arms, bump) in black on transparent, the eyes
// cut out so it reads as Buddi and not a bean, and the coral tip separated from the
// bump by a thin gap so the tip still reads in one colour. Template image: macOS
// draws it in the menu bar's ink, light or dark, and dims it with the bar.
// States, as the SF symbols before (b.circle.fill / b.circle / exclamationmark):
//   status-glyph            running                       full ink
//   status-glyph-starting   starting, stopped, updating   the same figure at 40 % ink
//   status-glyph-attention  needs attention               full ink, a dot badge cut in at the lower right
const GLYPH = {
  box: { x: 120, y: 95, size: 800 }, // the rig area the 18 pt square shows
  // tipGap: rig units between the coral tip and the bump; eyeGrow: how much larger
  // than the eye whites the cut-outs are, so they stay open. The @1x pixels (36
  // fewer per side) need both wider to read on a non-Retina display.
  at2x: { tipGap: 26, eyeGrow: 6 },
  at1x: { tipGap: 44, eyeGrow: 18 },
  dim: 0.4,       // the starting state's ink
  badge: { cx: 836, cy: 812, r: 84, ring: 40 },
};

function glyphSvg(state, { tipGap, eyeGrow } = GLYPH.at2x) {
  const { x, y, size } = GLYPH.box;
  const a = shape.antenna;
  const b = GLYPH.badge;
  const body = `<path d="${shape.silhouette}"/><path d="${shape.armL}"/><path d="${shape.armR}"/>`;
  const eyes = shape.eyes
    .map((e) => `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx + eyeGrow}" ry="${e.ry + eyeGrow}" fill="#000"/>`).join('');
  const tipCut = `<circle cx="${a.cx}" cy="${a.cy}" r="${a.r + tipGap}" fill="#000"/>`;
  const attention = state === 'attention';
  const badgeCut = attention ? `<circle cx="${b.cx}" cy="${b.cy}" r="${b.r + b.ring}" fill="#000"/>` : '';
  const badge = attention ? `<circle cx="${b.cx}" cy="${b.cy}" r="${b.r}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- buddi.app menu-bar glyph (${state}), generated by apps/mac/scripts/make-icons.mjs. Edit the script, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${size} ${size}" width="18" height="18">
  <defs>
    <mask id="cut" maskUnits="userSpaceOnUse" x="${x}" y="${y}" width="${size}" height="${size}">
      <rect x="${x}" y="${y}" width="${size}" height="${size}" fill="#fff"/>
      ${tipCut}${eyes}${badgeCut}
    </mask>
  </defs>
  <g fill="#000"${state === 'starting' ? ` opacity="${GLYPH.dim}"` : ''}>
    <g mask="url(#cut)">${body}</g>
    <circle cx="${a.cx}" cy="${a.cy}" r="${a.r}"/>${badge}
  </g>
</svg>
`;
}

// ---- the browser marks -----------------------------------------------------

// Where an icon stands alone in a browser (a tab, the toolbar, the extensions page)
// the Blob stands on its own, no tile: the tile's ground is lost at 16 px and fights
// a dark tab strip. Two cuts:
//   figure   the rig as drawn, feet included, fitted to a square (48 px and up)
//   small    the menu-bar glyph's bolder cut in colour, framed as the glyph is: eyes
//            and pupils grown, the coral tip grown, no mouth, feet or creases
const SMALL = {
  // The glyph's frame pulled up and in: the grown tip stays inside, the feet are gone.
  box: { x: 124, y: 74, size: 780 },
  16: { eyeGrow: 30, pupilGrow: 12, tipGrow: 30 },
  32: { eyeGrow: 10, pupilGrow: 6, tipGrow: 12, mouth: 20 },
};
// The rig's extent, feet and tip included, and the centre the figure is fitted on.
const EXTENT = { cx: 514, cy: 511, height: 792 };

function smallSvg(px) {
  const { x, y, size } = SMALL.box;
  const cut = SMALL[px];
  const a = shape.antenna;
  const c = shape.colour;
  const eyes = shape.eyes.map((e, i) => {
    const p = shape.pupils[i];
    return `<ellipse cx="${e.cx}" cy="${e.cy}" rx="${e.rx + cut.eyeGrow}" ry="${e.ry + cut.eyeGrow}" fill="${c.white}"/>` +
      `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx + cut.pupilGrow}" ry="${p.ry + cut.pupilGrow}" fill="${p.fill}"/>`;
  }).join('');
  const mouth = cut.mouth ? `<path d="${attr('mouth', 'd')}" fill="none" stroke="${attr('mouth', 'stroke')}" stroke-width="${cut.mouth}" stroke-linecap="round"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- buddi favicon, ${px} px cut, generated by apps/mac/scripts/make-icons.mjs from Design/buddi-blob-core.svg. Edit the script, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${size} ${size}" width="${px}" height="${px}">
  <g fill="${c.body}"><path d="${shape.silhouette}"/><path d="${shape.armL}"/><path d="${shape.armR}"/></g>
  ${eyes}${mouth}
  <circle cx="${a.cx}" cy="${a.cy}" r="${a.r + cut.tipGrow}" fill="${c.tip}"/>
</svg>
`;
}

/** The whole rig fitted to a square, the figure `fill` of its height. */
function figureSvg(fill) {
  const size = +(EXTENT.height / fill).toFixed(2);
  const x = +(EXTENT.cx - size / 2).toFixed(2), y = +(EXTENT.cy - size / 2).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- buddi icon (figure, ${Math.round(fill * 100)} %), generated by apps/mac/scripts/make-icons.mjs from Design/buddi-blob-core.svg. Edit the script, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${size} ${size}" width="512" height="512">
  ${rigBody.replace(/\n/g, '\n  ')}
</svg>
`;
}

// The og image: the kit's page ground, the Blob at left, the wordmark at right in
// the kit's display face at the site header's weight (650, approximated by a stroke
// of the ink: resvg draws a variable font at its default instance).
const OG = { width: 1200, height: 630, blob: { cx: 345, cy: 322, height: 440 }, word: { x: 610, baseline: 388, size: 176 } };
const INK = '#152642';

function ogSvg(withText) {
  const { width: W, height: H, blob, word } = OG;
  const ground = pageGround(0, 0, W, H);
  const s = blob.height / EXTENT.height;
  const tx = +(blob.cx - EXTENT.cx * s).toFixed(2), ty = +(blob.cy - EXTENT.cy * s).toFixed(2);
  const text = withText
    ? `\n  <text x="${word.x}" y="${word.baseline}" font-family="DM Sans" font-size="${word.size}" letter-spacing="${-0.01 * word.size}" fill="${INK}" stroke="${INK}" stroke-width="${+(word.size * 0.022).toFixed(2)}" stroke-linejoin="round">buddi</text>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- buddi og image, generated by apps/mac/scripts/make-icons.mjs from Design/buddi-blob-core.svg. Edit the script, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    ${ground.wash}
    ${ground.glows.join('\n    ')}
    ${BLOB_SHADOW}
  </defs>
  ${ground.rects.join('\n  ')}
  <g filter="url(#blobShadow)">
    <g transform="translate(${tx} ${ty}) scale(${+s.toFixed(4)})">
      ${rigBody.replace(/\n/g, '\n      ')}
    </g>
  </g>${text}
</svg>
`;
}

/** An ICO whose entries are PNGs (every browser since IE 11 reads them). */
function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ px, png }, i) => {
    const at = 6 + 16 * i;
    head[at] = px >= 256 ? 0 : px; head[at + 1] = px >= 256 ? 0 : px;
    head.writeUInt16LE(1, at + 4); head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8); head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

// ---- rendering -------------------------------------------------------------

/** The exact versions this script renders with; resvg's prebuilt binaries come as optional dependencies, no install script needed. */
const RESVG_VERSION = '2.6.2';
const WAWOFF2_VERSION = '2.0.1';
const cache = join(homedir(), 'Library/Caches/buddi-make-icons');

/** A package from here, else from the cache, installed there at `version` when missing or different. */
async function load(name, version) {
  try {
    return await import(name);
  } catch {
    const installed = (() => {
      try { return JSON.parse(readFileSync(join(cache, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return undefined; }
    })();
    if (installed !== version) {
      mkdirSync(cache, { recursive: true });
      console.log(`installing ${name}@${version} into ${cache}`);
      execFileSync('npm', ['install', '--prefix', cache, '--no-audit', '--no-fund', '--silent', '--ignore-scripts', '--save-exact', `${name}@${version}`], { stdio: 'inherit' });
    }
    return createRequire(join(cache, 'package.json'))(name);
  }
}

/** DM Sans as a TTF resvg can read, decoded once from the extension's woff2; undefined when that fails. */
async function displayFont() {
  const ttf = join(cache, `dm-sans-${WAWOFF2_VERSION}.ttf`);
  if (existsSync(ttf)) return ttf;
  try {
    const woff2 = readFileSync(join(repo, 'packages/extension/static/fonts/dm-sans-latin-standard-normal.woff2'));
    const wawoff2 = await load('wawoff2', WAWOFF2_VERSION);
    const decompress = wawoff2.decompress ?? wawoff2.default?.decompress;
    mkdirSync(cache, { recursive: true });
    writeFileSync(ttf, Buffer.from(await decompress(woff2)));
    return ttf;
  } catch (error) {
    console.warn(`no DM Sans for the og image (${error.message}); it goes out without the wordmark`);
    return undefined;
  }
}

const resvg = await load('@resvg/resvg-js', RESVG_VERSION);
const Resvg = resvg.Resvg ?? resvg.default?.Resvg;
const render = (svg, px, font) => new Resvg(svg, {
  fitTo: { mode: 'width', value: px }, background: 'rgba(0,0,0,0)',
  ...(font ? { font: { fontFiles: [font], loadSystemFonts: false, defaultFontFamily: 'DM Sans' } } : {}),
}).render().asPng();
const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const json = (value) => JSON.stringify(value, null, 2) + '\n';

if (targets.mac) {
  // App icon.
  const icon = appIconSvg();
  write(join(designDir, 'app-icon.svg'), icon);
  const iconSet = join(assets, 'AppIcon.appiconset');
  const images = [];
  for (const pt of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = pt * scale;
      const filename = `icon_${px}.png`;
      write(join(iconSet, filename), render(icon, px));
      images.push({ idiom: 'mac', size: `${pt}x${pt}`, scale: `${scale}x`, filename });
    }
  }
  write(join(iconSet, 'Contents.json'), json({ images, info: { author: 'xcode', version: 1 } }));

  // Menu-bar glyphs.
  const glyphs = { running: 'StatusGlyph', starting: 'StatusGlyphStarting', attention: 'StatusGlyphAttention' };
  for (const [state, name] of Object.entries(glyphs)) {
    const svg = glyphSvg(state);
    const file = state === 'running' ? 'status-glyph' : `status-glyph-${state}`;
    write(join(designDir, `${file}.svg`), svg);
    const set = join(assets, `${name}.imageset`);
    write(join(set, `${file}.png`), render(glyphSvg(state, GLYPH.at1x), 18));
    write(join(set, `${file}@2x.png`), render(svg, 36));
    write(join(set, 'Contents.json'), json({
      images: [
        { idiom: 'universal', scale: '1x', filename: `${file}.png` },
        { idiom: 'universal', scale: '2x', filename: `${file}@2x.png` },
      ],
      info: { author: 'xcode', version: 1 },
      properties: { 'template-rendering-intent': 'template' },
    }));
  }
  console.log('mac: Design/ and the asset catalog');
}

if (targets.web || targets.extension || targets.site) {
  const svgs = {
    'favicon-16': smallSvg(16),
    'favicon-32': smallSvg(32),
    'icon-figure': figureSvg(0.94),
    'icon-figure-padded': figureSvg(0.78),
    'icon-bleed': appIconSvg('bleed'),
    'icon-maskable': appIconSvg('maskable'),
    'og-image': ogSvg(true),
  };
  for (const [name, svg] of Object.entries(svgs)) write(join(designDir, `${name}.svg`), svg);
  const tile = appIconSvg();

  /** The favicon set and the app icons, as the dashboard and the site both serve them. */
  const webSet = (dir) => {
    const favicon16 = render(svgs['favicon-16'], 16);
    const favicon32 = render(svgs['favicon-32'], 32);
    write(join(dir, 'favicon.ico'), ico([{ px: 16, png: favicon16 }, { px: 32, png: favicon32 }, { px: 48, png: render(svgs['icon-figure'], 48) }]));
    write(join(dir, 'favicon-16.png'), favicon16);
    write(join(dir, 'favicon-32.png'), favicon32);
    write(join(dir, 'apple-touch-icon.png'), render(svgs['icon-bleed'], 180));
    write(join(dir, 'icon-192.png'), render(tile, 192));
    write(join(dir, 'icon-512.png'), render(tile, 512));
    write(join(dir, 'maskable-512.png'), render(svgs['icon-maskable'], 512));
  };

  if (targets.web) {
    webSet(join(repo, 'packages/web/public'));
    console.log('web: packages/web/public');
  }
  if (targets.extension) {
    // Chrome's toolbar draws 16 and 32; the extensions page 48; the store and the
    // install prompt 128, which wants the art about 96 px with clear space around.
    const dir = join(repo, 'packages/extension/static/icons');
    write(join(dir, '16.png'), render(svgs['favicon-16'], 16));
    write(join(dir, '32.png'), render(svgs['favicon-32'], 32));
    write(join(dir, '48.png'), render(svgs['icon-figure'], 48));
    write(join(dir, '128.png'), render(svgs['icon-figure-padded'], 128));
    console.log('extension: packages/extension/static/icons');
  }
  if (targets.site) {
    if (existsSync(siteDir)) {
      const dir = join(siteDir, 'public');
      webSet(dir);
      const font = await displayFont();
      write(join(dir, 'og-image.png'), render(ogSvg(Boolean(font)), OG.width, font));
      console.log(`site: ${dir}`);
    } else if (siteArg) {
      throw new Error(`no buddi-site at ${siteDir}`);
    } else {
      console.log(`site: skipped, no buddi-site at ${siteDir} (pass --site=<dir>)`);
    }
  }
}

console.log(`icons written from ${rigPath}`);
