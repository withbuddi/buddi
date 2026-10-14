# Composing a Word document

You write one ES module. It imports from `docx` and nothing else, and its
default export returns the finished file:

```js
import { Document, Packer, Paragraph, TextRun } from 'docx';

export default async (ctx) => {
  const doc = new Document({ sections: [{ children: [new Paragraph('Hello')] }] });
  return Packer.toBuffer(doc);
};
```

buddi runs it with no network, no file access and no other packages, then
stores the bytes as the file's next version and keeps your program beside
it. `ctx.files` holds the pictures you passed as `attachments`; nothing else
gets in. Read `artifacts.compose { guide: 'layout' }` for type, colour and
spacing choices that hold for Word and PowerPoint alike.

## Units, once

- Page size, margins, indents and tab stops are in **twips**: 1440 per inch,
  about 567 per centimetre.
- Font size is in **half-points**: `size: 22` is 11 pt.
- Paragraph spacing (`before`, `after`) is in twips (`after: 120` is 6 pt);
  line spacing `line` is in 240ths of a line (`240` single, `276` is 1.15).
- Borders are in eighths of a point (`size: 8` is 1 pt). Colours are hex
  without `#`: `'1F3A5F'`.
- Pictures in `ImageRun` are sized in pixels at 96 per inch
  (`transformation: { width: 144, height: 48 }` is 1.5 × 0.5 in).

## A skeleton to start from

```js
import {
  AlignmentType, BorderStyle, Document, Footer, Header, Packer, PageNumber,
  Paragraph, TabStopType, TextRun,
} from 'docx';

const ACCENT = '1F3A5F';
const MUTED = '6B7280';
const BODY = 'Calibri';

export default async (ctx) => {
  const doc = new Document({
    creator: 'buddi',
    title: 'Offer',
    styles: {
      default: {
        document: { run: { font: BODY, size: 22, color: '1F2328' }, paragraph: { spacing: { after: 120, line: 276 } } },
        heading1: { run: { font: BODY, size: 32, bold: true, color: ACCENT }, paragraph: { spacing: { before: 360, after: 120 } } },
        heading2: { run: { font: BODY, size: 26, bold: true, color: ACCENT }, paragraph: { spacing: { before: 240, after: 80 } } },
      },
    },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: 'Northwind Ltd', bold: true, color: ACCENT })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 18, color: MUTED })],
      })] }) },
      children: [
        new Paragraph({ heading: 'Heading1', children: [new TextRun('Offer for the kitchen renovation')] }),
        new Paragraph({ children: [new TextRun({ text: '13 October 2026', color: MUTED })] }),
        new Paragraph('Thank you for the visit last week. Here is what we propose.'),
      ],
    }],
  });
  return Packer.toBuffer(doc);
};
```

A4 is 11906 × 16838 twips; US Letter is 12240 × 15840. Use the owner's
paper: Letter in the United States and Canada, A4 nearly everywhere else.
For landscape, swap width and height and add `orientation: 'landscape'`.

## A complete letter

Sender at the top, the recipient where a window envelope shows it, the date
and a reference on one line, the subject, the body, and room to sign. Fill
every name, address and figure from what you read; leave a visible
`[placeholder]` for what you do not know and say so.

```js
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TabStopType, TextRun } from 'docx';

const ACCENT = '1F3A5F';
const MUTED = '6B7280';
const TEXT_WIDTH = 11906 - 2 * 1247; // A4 width minus both margins, in twips

const line = (text, opts = {}) => new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text, ...opts })] });

export default async () => {
  const sender = ['Amina Diallo', '14 Rue des Lilas', '75011 Paris', 'amina@example.com'];
  const recipient = ['Northwind Ltd', 'Attn. Jonas Berg', '2 Harbour Street', 'Oslo 0150'];
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 160, line: 276 } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1247, bottom: 1134, left: 1247 } } },
      children: [
        new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: sender[0], bold: true, size: 28, color: ACCENT })] }),
        ...sender.slice(1).map((l) => line(l, { color: MUTED, size: 20 })),
        new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 4 } }, spacing: { after: 600 } }),
        ...recipient.map((l) => line(l)),
        new Paragraph({
          spacing: { before: 480, after: 240 },
          tabStops: [{ type: TabStopType.RIGHT, position: TEXT_WIDTH }],
          children: [new TextRun('Paris, 13 October 2026'), new TextRun({ text: '\tOur ref. 2026-114', color: MUTED })],
        }),
        new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: 'Offer for the kitchen renovation', bold: true })] }),
        new Paragraph('Dear Mr Berg,'),
        new Paragraph('Thank you for your visit on 6 October. As agreed, here is our offer for the work we discussed.'),
        new Paragraph('The price is fixed for thirty days. I would be glad to go through it with you by phone.'),
        new Paragraph({ spacing: { before: 240 }, children: [new TextRun('Kind regards,')] }),
        new Paragraph({ spacing: { before: 720, after: 0 }, children: [new TextRun({ text: 'Amina Diallo', bold: true })] }),
        line('Owner, Diallo Interiors', { color: MUTED }),
      ],
    }],
  });
  return Packer.toBuffer(doc);
};
```

## Headings and the outline

Give each heading `heading: 'Heading1'` (or `HeadingLevel.HEADING_1`) rather
than a bold paragraph: Word builds its navigation pane and any table of
contents from them, and buddi's render summary reads your outline from them.
Use the levels in order — a Heading 3 under a Heading 1 reads as a mistake.
Style them once in `styles.default.heading1…heading3`, never per paragraph.

## A horizontal rule

A paragraph with a bottom border, kept short on space:

```js
new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT, space: 4 } }, spacing: { after: 240 } })
```

## Letterhead and address block

The sender's name and address go in the header, or at the top of the first
page; the recipient's block sits at the left margin about 2 in from the top
edge, so it shows in a window envelope. The owner's own letterhead skill, if
one is installed, is the source of their name, address and footer line: take
them from there, never invent them.

A date and a reference on one line, the reference pushed to the right margin
with a right tab stop (its position is the text width in twips):

```js
new Paragraph({
  tabStops: [{ type: TabStopType.RIGHT, position: 9638 }],
  children: [new TextRun('13 October 2026'), new TextRun({ text: '\tRef. 2026-114', color: MUTED })],
})
```

## Tables

```js
import { ShadingType, Table, TableCell, TableRow, WidthType } from 'docx';

const cell = (text, opts = {}) => new TableCell({
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
  shading: opts.head ? { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF2F7' } : undefined,
  children: [new Paragraph({ alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
    children: [new TextRun({ text, bold: !!opts.head })] })],
});
const table = new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  columnWidths: [6000, 1800, 1838],
  rows: [
    new TableRow({ tableHeader: true, children: [cell('Item', { head: true }), cell('Qty', { head: true, right: true }), cell('Amount', { head: true, right: true })] }),
    new TableRow({ children: [cell('Cabinets'), cell('12', { right: true }), cell('4,800.00', { right: true })] }),
  ],
});
```

- Numbers are right-aligned and formatted the same way in every row (same
  decimals, thousands separator, currency in the header rather than in each
  cell).
- `tableHeader: true` repeats the header row on every page.
- Light horizontal rules and a tinted header read better than a full grid.
  Set `borders` on cells (`{ top: { style: BorderStyle.NONE } }`…) when the
  default grid is too heavy.
- `columnWidths` in twips should add up to the text width (page width minus
  both margins).

## Lists

Simple bullets: `new Paragraph({ text: 'Delivery in March', bullet: { level: 0 } })`.
Numbered lists need a numbering definition in the Document
(`numbering: { config: [{ reference: 'steps', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.LEFT }] }] }`)
and `numbering: { reference: 'steps', level: 0 }` on each paragraph.

## Pictures

```js
import { ImageRun } from 'docx';
const logo = ctx.file('logo.png'); // or ctx.files[0]; null when it was not attached
new Paragraph({ children: [new ImageRun({ type: logo.type, data: logo.bytes,
  transformation: { width: 160, height: Math.round(160 * logo.height / logo.width) } })] })
```

Keep the aspect ratio from `width` and `height`. Look at a photo with
`artifacts.view` before you use it: a dark or busy picture under text, or a
low-resolution logo stretched wide, spoils the page.

## Signature block

Leave room to sign: the closing ("Kind regards,"), three or four empty lines
of spacing (`spacing: { before: 720 }` on the name), then the name in bold
and the role or company in the muted colour beneath.

## Page breaks and keeping together

- `pageBreakBefore: true` on the paragraph that must start a page (a new
  chapter), rather than empty paragraphs.
- `keepNext: true` on a heading keeps it with the paragraph after it;
  `keepLines: true` keeps a short paragraph on one page.

## Gotchas

- Return `Packer.toBuffer(doc)`, not `doc`.
- A `Paragraph` takes `children: [TextRun…]`; a plain string is a shortcut
  for a single unstyled run only.
- Line breaks inside a run: `new TextRun({ text: 'Line one', break: 1 })`
  breaks before it; `\n` in a text does nothing.
- Every `TableRow` must have the same number of cells unless you use
  `columnSpan`.
- Fonts are not embedded. Use ones the owner's computer has (Calibri,
  Cambria, Georgia, Arial, Helvetica, Garamond on most); others are replaced.
- `import` only from `docx`. `fs`, `fetch` and other packages are refused.

## Checklist against `render`

Every compose reply carries `render`. Before showing the document:

1. `page` is the owner's paper size and the margins you meant.
2. `fonts` lists at most two families, the ones you chose.
3. `outline` reads like a table of contents: levels in order, no gaps.
4. `pages.estimated` is about what the content should take; a one-page
   letter estimated at two needs tightening.
5. `tables` has the rows and columns you meant; `images` the pictures.
6. `header` and `footer` are there if you set them.
7. The opening `text` says the right thing first.

Use `dryRun: true` while you iterate; save only the version you would show.
