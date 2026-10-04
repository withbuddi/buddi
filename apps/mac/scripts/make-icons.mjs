#!/usr/bin/env node
// buddi.app's icons, drawn from the Buddi Blob vector rig.
//
//   node scripts/make-icons.mjs [path/to/buddi-blob-core.svg]
//
// With a path, that rig (buddi-design/mascot/rig/buddi-blob-core.svg) replaces the
// copy in Design/ first; without one, the committed copy is used. It writes:
//
//   Design/app-icon.svg              the dock icon's composition (macOS grid, kit ground)
//   Design/status-glyph*.svg         the menu-bar glyph, one per state
//   Resources/Assets.xcassets/AppIcon.appiconset/icon_*.png   16 … 1024
//   Resources/Assets.xcassets/StatusGlyph*.imageset/*.png     18 pt, @1x and @2x, template
//
// Rendering is resvg (@resvg/resvg-js), installed once into ~/Library/Caches/buddi-make-icons
// when it cannot be imported from here.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const mac = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const designDir = join(mac, 'Design');
const assets = join(mac, 'Resources/Assets.xcassets');
const rigPath = join(designDir, 'buddi-blob-core.svg');

if (process.argv[2]) {
  mkdirSync(designDir, { recursive: true });
  copyFileSync(resolve(process.argv[2]), rigPath);
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

function appIconSvg() {
  const { x, y, size } = GRID;
  const r = size * 0.224;
  const tile = squircle(x, y, size, size, r);
  const top = shape.antenna.cy - shape.antenna.r;
  const s = FRAME.scale;
  const tx = 512 - FRAME.centreX * s;
  const ty = FRAME.antennaTop - top * s;
  const glows = PAGE.glows.map((g, i) => {
    const cx = x + g.at[0] * size, cy = y + g.at[1] * size;
    const rx = g.size[0] * size, ry = g.size[1] * size;
    return `<radialGradient id="glow${i}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${rx}" gradientTransform="translate(${cx} ${cy}) scale(1 ${ry / rx}) translate(${-cx} ${-cy})">
      <stop offset="0" stop-color="${g.color}" stop-opacity="${g.opacity}"/>
      <stop offset="0.7" stop-color="${g.color}" stop-opacity="0"/>
    </radialGradient>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- buddi.app icon, generated by apps/mac/scripts/make-icons.mjs from Design/buddi-blob-core.svg. Edit the script, not this file. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <clipPath id="tile"><path d="${tile}"/></clipPath>
    <linearGradient id="wash" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${PAGE.top}"/>
      <stop offset="1" stop-color="${PAGE.bottom}"/>
    </linearGradient>
    ${glows.join('\n    ')}
    <filter id="tileShadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity="0.28"/>
    </filter>
    <filter id="blobShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#152642" flood-opacity="0.18"/>
    </filter>
  </defs>
  <path d="${tile}" fill="${PAGE.bottom}" filter="url(#tileShadow)"/>
  <g clip-path="url(#tile)">
    <rect x="${x}" y="${y}" width="${size}" height="${size}" fill="url(#wash)"/>
    ${PAGE.glows.map((_, i) => `<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="url(#glow${i})"/>`).join('\n    ')}
    <g filter="url(#blobShadow)">
      <g transform="translate(${+tx.toFixed(2)} ${+ty.toFixed(2)}) scale(${s})">
        ${rigBody.replace(/\n/g, '\n        ')}
      </g>
    </g>
  </g>
</svg>
`;
}

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

// ---- rendering -------------------------------------------------------------

async function loadResvg() {
  try {
    return (await import('@resvg/resvg-js')).Resvg;
  } catch {
    const cache = join(homedir(), 'Library/Caches/buddi-make-icons');
    if (!existsSync(join(cache, 'node_modules/@resvg/resvg-js'))) {
      mkdirSync(cache, { recursive: true });
      console.log(`installing @resvg/resvg-js into ${cache}`);
      execFileSync('npm', ['install', '--prefix', cache, '--no-audit', '--no-fund', '--silent', '@resvg/resvg-js@2'], { stdio: 'inherit' });
    }
    return createRequire(join(cache, 'package.json'))('@resvg/resvg-js').Resvg;
  }
}

const Resvg = await loadResvg();
const render = (svg, px) => new Resvg(svg, { fitTo: { mode: 'width', value: px }, background: 'rgba(0,0,0,0)' }).render().asPng();
const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const json = (value) => JSON.stringify(value, null, 2) + '\n';

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

console.log(`icons written from ${rigPath}`);
