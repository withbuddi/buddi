# Composing a PowerPoint deck

You write one ES module. It imports `pptxgenjs` and nothing else, and its
default export returns the finished file:

```js
import PptxGenJS from 'pptxgenjs';

export default async (ctx) => {
  const pres = new PptxGenJS();
  pres.addSlide().addText('Hello', { x: 1, y: 1, w: 8, h: 1 });
  return pres.write({ outputType: 'nodebuffer' });
};
```

buddi runs it with no network, no file access and no other packages, then
stores the bytes as the deck's next version and keeps your program beside
it. `ctx.files` holds the pictures you passed as `attachments`. Read
`artifacts.compose { guide: 'layout' }` for type, colour and spacing.

## Units, once

- Positions and sizes (`x`, `y`, `w`, `h`) are in **inches** from the
  slide's top-left corner. Percentages work too (`w: '100%'`).
- Font sizes are in **points**. Line and border widths (`pt`) in points.
- Colours are hex without `#`: `'1F3A5F'`.
- `LAYOUT_WIDE` (16:9) is 13.333 × 7.5 in; `LAYOUT_16x9` is 10 × 5.625 in;
  `LAYOUT_4x3` is 10 × 7.5 in. Pick one and lay out against its size.

## A skeleton to start from

```js
import PptxGenJS from 'pptxgenjs';

const ACCENT = '1F3A5F';
const INK = '1F2328';
const MUTED = '6B7280';
const FONT = 'Calibri';
const W = 13.333, H = 7.5, M = 0.6; // slide size and outer margin

export default async (ctx) => {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.title = 'Quarterly review';

  pres.defineSlideMaster({
    title: 'CONTENT',
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: 0, w: W, h: 0.12, fill: { color: ACCENT } } },
      { text: { text: 'Northwind · Q3 2026', options: { x: M, y: H - 0.5, w: 6, h: 0.3, fontFace: FONT, fontSize: 10, color: MUTED } } },
    ],
    slideNumber: { x: W - M - 0.6, y: H - 0.5, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: MUTED, align: 'right' },
  });

  // Title slide
  const title = pres.addSlide();
  title.background = { color: ACCENT };
  title.addText('Quarterly review', { x: M, y: 2.6, w: W - 2 * M, h: 1.2, fontFace: FONT, fontSize: 44, bold: true, color: 'FFFFFF' });
  title.addText('Q3 2026 · prepared for the board', { x: M, y: 3.8, w: W - 2 * M, h: 0.6, fontFace: FONT, fontSize: 20, color: 'D9E2EC' });

  // A content slide: one message as the title, three points under it
  const s = pres.addSlide({ masterName: 'CONTENT' });
  s.addText('Revenue grew 12% on repeat customers', { x: M, y: 0.5, w: W - 2 * M, h: 0.9, fontFace: FONT, fontSize: 30, bold: true, color: INK });
  s.addText([
    { text: 'Repeat orders up from 38% to 46% of sales', options: { bullet: true } },
    { text: 'Average order value flat at 212 EUR', options: { bullet: true } },
    { text: 'Two new wholesale accounts from August', options: { bullet: true } },
  ], { x: M, y: 1.7, w: 7.4, h: 3.6, fontFace: FONT, fontSize: 20, color: INK, paraSpaceAfter: 10, valign: 'top' });

  return pres.write({ outputType: 'nodebuffer' });
};
```

## One message per slide

- The title states the point ("Revenue grew 12% on repeat customers"), not
  the topic ("Revenue"). Someone reading only the titles should get the
  story.
- Three to five bullets at most, each one line where possible. Long text
  belongs in the speaker notes: `slide.addNotes('…')`.
- Section slides (a coloured background, the section name large) mark the
  turns of a long deck; a deck under ten slides rarely needs them.
- End on what you ask for or what happens next, not "Questions?".

## Layout

- Keep every object inside the outer margin (0.5–0.7 in). buddi's render
  summary warns about anything that reaches past the slide's edge.
- Work on a grid: a left column at `x: M`, a right column starting past the
  middle, the same `y` for the first line of body text on every slide.
- Give a text box the height its text needs. pptxgenjs does not grow boxes;
  text that does not fit spills out of the box on the slide. The render
  summary estimates that and warns ("likely overflows its box"). Shorten the
  text, enlarge the box or lower the size — not below 16 pt for body text.
- `valign: 'top'` for body text, so lines start at the same height whatever
  their count.

## Tables

```js
s.addTable([
  [{ text: 'Region', options: { bold: true, fill: { color: 'EEF2F7' } } },
   { text: 'Sales', options: { bold: true, fill: { color: 'EEF2F7' }, align: 'right' } }],
  ['North', { text: '1,240,000', options: { align: 'right' } }],
  ['South', { text: '  980,500', options: { align: 'right' } }],
], { x: M, y: 1.7, w: 7, colW: [4.5, 2.5], fontFace: FONT, fontSize: 16, color: INK,
     border: { type: 'solid', pt: 0.5, color: 'D0D7DE' } });
```

Numbers right-aligned, same decimals in a column, the unit in the header.
Six or seven rows is the most a slide holds legibly; more is an appendix or
a chart.

## Charts

`slide.addChart(pres.ChartType.bar, [{ name: 'Sales', labels: ['Q1','Q2','Q3'], values: [1.1, 1.3, 1.4] }], { x, y, w, h, chartColors: [ACCENT], showValue: true, valAxisHidden: true, catAxisLabelFontSize: 14 })`.
A chart makes one comparison; say it in the title. Use the accent for the
series that matters and grey for the rest.

## Pictures

```js
const photo = ctx.file('team.jpg'); // or ctx.files[0]; null when it was not attached
s.addImage({ data: photo.dataUri, x: 8.3, y: 1.7, w: 4.4, h: 4.4 * photo.height / photo.width });
```

Keep the aspect ratio from `width` and `height`, or crop with
`sizing: { type: 'cover', w, h }`. Look at a photo with `artifacts.view`
first: text over a busy photo needs a solid band behind it.

## Shapes

`s.addShape(pres.ShapeType.rect, { x, y, w, h, fill: { color: 'EEF2F7' }, line: { color: 'EEF2F7' } })`
draws a panel; draw it before the text that sits on it (later objects are on
top). `pres.ShapeType.line` with `line: { color, width: 1 }` draws a rule.

## Gotchas

- Return `await pres.write({ outputType: 'nodebuffer' })`, not `pres`, and
  never `writeFile` (there is no disk).
- Text runs in an array each take `options`; `breakLine: true` ends a line
  without a bullet.
- `fontFace` is not embedded: Calibri, Arial, Helvetica, Georgia or Segoe
  UI are safe; anything else is replaced on the owner's machine.
- Colours are 6-digit hex without `#`; a `#` makes PowerPoint drop the colour.
- `import` only `pptxgenjs`. `fs`, `fetch`, `https` and other packages are
  refused.

## Checklist against `render`

1. `slide` is the size you laid out against.
2. `warnings` is empty: nothing past an edge, no text spilling out of a box.
3. `fonts` lists at most two families.
4. Each slide's `title` states its point, and reading the titles in order
   tells the story.
5. `shapes` per slide is modest: a slide with twenty objects is a document.

Use `dryRun: true` while you iterate; save only the deck you would show.
