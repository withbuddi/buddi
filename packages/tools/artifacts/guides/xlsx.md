# Composing an Excel workbook

You write one ES module. It imports `write-excel-file` and nothing else,
builds each sheet as rows of cells, and returns the file:

```js
import writeXlsxFile from 'write-excel-file';

export default async (ctx) => {
  const blob = await writeXlsxFile([{ sheet: 'Sheet1', data: [['Hello']] }]).toBlob();
  return Buffer.from(await blob.arrayBuffer());
};
```

buddi runs it with no network, no files and no other packages. Before it
stores the file it works out every formula's value and writes it in, so the
totals show in Quick Look, on a phone and in a mail preview; Excel and
Numbers recompute them when the file opens. Read `artifacts.compose { guide:
'layout' }` for colour and type choices shared with Word and PowerPoint.

## When to compose a sheet

A flat table the owner asked for as a spreadsheet — one sheet, a header, no
formulas — is `artifacts.write` with format `xlsx`. Compose when the sheet
has a formula, a number format, a cell the owner fills in, or more than one
sheet, and whenever it was asked for as a budget, model, tracker, plan or
calculator.

## Cells, rows, sheets

- A sheet is `{ sheet: 'Name', data, columns, stickyRowsCount, conditionalFormatting }`;
  `data` is an array of rows, a row an array of cells, top-left first.
- A cell is a value (`'Flights'`, `420`, `true`, a `Date`), `null` for an
  empty one, or an object: `{ value, type, format, fontWeight: 'bold',
  fontStyle: 'italic', textColor: '#9C0006', backgroundColor: '#EEF3F8',
  align: 'right', wrap: true, topBorderStyle: 'thin', columnSpan: 2 }`.
- An empty cell the owner fills in is `{ type: Number, value: null, format,
  backgroundColor }`: a `format` needs a `type` when there is no value.
- A formula is `{ type: 'Formula', value: '=SUM(B2:B6)' }`. Refer across
  sheets with `Costs!B7`, or `'Trip costs'!B7` when the name has a space.
- Rows and columns count from 1 in conditional ranges, as Excel's do.
- Column widths are in characters: `columns: [{ width: 28 }, { width: 14 }]`.
  Size each column to its longest entry plus two; 10–14 for amounts.
- Sheet names: 31 characters at most, no `[]:*?/\`.
- `stickyRowsCount: 1` freezes the header; `stickyColumnsCount: 1` the
  first column too, for a wide sheet.

## The model shape

Every workbook that calculates something has three parts, in this order:

1. **Inputs**: the numbers the owner gives or will change — prices, rates,
   dates, quantities. Mark each input cell with a pale fill
   (`backgroundColor: '#FFF7E0'`) and say so in a note row, so he knows what
   to type over.
2. **Calculations**: formulas only. Never type a number where a formula
   belongs: a total that is a typed number is wrong the moment he edits an
   input.
3. **Outputs**: the totals and answers, bold, with a thin rule above
   (`topBorderStyle: 'thin'`).

With more than one sheet, put a **Summary** sheet first: the answers, each
a formula reading the detail sheets. The detail follows, one sheet per topic.

## Number formats

Give every number a format; a bare `0.3333333` is never right.

| For | `format` |
| --- | --- |
| Euros | `'"€"#,##0.00'` |
| Dollars, negatives red | `'$#,##0.00;[Red]-$#,##0.00'` |
| Whole amounts | `'#,##0'` |
| Percent | `'0%'` or `'0.0%'` (store 0.25, not 25) |
| A date | `'d mmm yyyy'` (13 Oct 2026), or `'mm/dd/yyyy'` in the US |
| A month | `'mmm yyyy'` |
| Count | `'0'` |

A date cell is `{ value: new Date(Date.UTC(2026, 9, 13)), type: Date, format: 'd mmm yyyy' }`.
Use the owner's currency and his way of writing dates.

## Colour and type

One accent and neutrals, as `layout.md` says: the header row in the accent
(`backgroundColor: '#1F3A5F'`, `textColor: '#FFFFFF'`, bold), body text
black on white, a light grey (`'#F3F4F6'`) for a band or a subtotal row,
the input fill for inputs. Red only for what is over or negative. The
workbook's font is set once: `writeXlsxFile(sheets, { fontFamily: 'Calibri',
fontSize: 11 })`.

## Conditional formatting

```js
conditionalFormatting: [
  // An amount over 1,000 in red.
  { cellRange: { from: { row: 2, column: 3 }, to: { row: 20, column: 3 } },
    condition: { operator: '>', value: 1000 }, style: { textColor: '#C00000' } },
  // A whole row when its actual (D) is over its budget (C).
  { cellRange: { from: { row: 2, column: 1 }, to: { row: 20, column: 4 } },
    condition: { formula: '=$D2>$C2' }, style: { backgroundColor: '#FDECEC' } },
],
```

Operators: `<`, `<=`, `>`, `>=`, `=`, `!=`, and `'...'` with `value` and
`value2` for between. A row rule's formula is written for the range's first
row; keep the column absolute (`$D2`) and the row relative.

## Functions

buddi computes these itself, for the values it writes in and the preview:
SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, IFERROR, ROUND, SUMIF, SUMIFS,
COUNTIF, COUNTIFS, AVERAGEIF(S), VLOOKUP, INDEX, MATCH, SUBTOTAL, TEXT,
DATE, TODAY, and the arithmetic (`+ - * / ^ &`, comparisons). Stay within
them. Another function (XLOOKUP, FILTER, LET…) works in Excel, but buddi
leaves its cell without a value: blank in the preview and in Quick Look
until the file is opened in Excel. A subtotal row uses
`SUBTOTAL(9, B2:B5)`, and a grand total `SUBTOTAL(9, B2:B12)` then skips
the subtotals inside its range.

## Not possible here

Charts, data validation (drop-down lists), named ranges, pivot tables and
macros. If the owner wants one, make the sheet without it and tell him what
to add in Excel.

## A worked budget

```js
import writeXlsxFile from 'write-excel-file';

const ACCENT = '#1F3A5F';
const INPUT = '#FFF7E0';
const EUR = '"€"#,##0.00';
const head = (value) => ({ value, fontWeight: 'bold', textColor: '#FFFFFF', backgroundColor: ACCENT });
const input = (value) => ({ type: Number, value, format: EUR, backgroundColor: INPUT });
const sum = (formula) => ({ type: 'Formula', value: formula, format: EUR, fontWeight: 'bold', topBorderStyle: 'thin' });

export default async () => {
  const items = [['Flights', 420, 455], ['Hotel', 600, 560], ['Food', 250, 310], ['Museums', 80, 64]];
  const rows = items.map(([name, budget, actual], i) => [
    name, input(budget), input(actual),
    { type: 'Formula', value: `=C${i + 2}-B${i + 2}`, format: `${EUR};[Red]-${EUR}` },
  ]);
  const last = items.length + 1;
  const costs = {
    sheet: 'Costs',
    data: [
      [head('Item'), head('Budget'), head('Actual'), head('Difference')],
      ...rows,
      [{ value: 'Total', fontWeight: 'bold', topBorderStyle: 'thin' }, sum(`=SUM(B2:B${last})`), sum(`=SUM(C2:C${last})`), sum(`=SUM(D2:D${last})`)],
    ],
    columns: [{ width: 18 }, { width: 14 }, { width: 14 }, { width: 14 }],
    stickyRowsCount: 1,
    conditionalFormatting: [{
      cellRange: { from: { row: 2, column: 1 }, to: { row: last, column: 4 } },
      condition: { formula: '=$C2>$B2' }, style: { textColor: '#C00000' },
    }],
  };
  const summary = {
    sheet: 'Summary',
    data: [
      [head('Trip to Lisbon'), head('')],
      ['Budget', { type: 'Formula', value: `=Costs!B${last + 1}`, format: EUR }],
      ['Spent', { type: 'Formula', value: `=Costs!C${last + 1}`, format: EUR }],
      ['Left', { type: 'Formula', value: '=B2-B3', format: `${EUR};[Red]-${EUR}`, fontWeight: 'bold' }],
      ['Over budget?', { type: 'Formula', value: '=IF(B4<0,"yes","no")' }],
      [{ value: 'Yellow cells are yours to change.', fontStyle: 'italic', textColor: '#6B7280', columnSpan: 2 }, null],
    ],
    columns: [{ width: 22 }, { width: 16 }],
  };
  const blob = await writeXlsxFile([summary, costs], { fontFamily: 'Calibri', fontSize: 11 }).toBlob();
  return Buffer.from(await blob.arrayBuffer());
};
```

## Changing it later

Read the program (`{ fileId, source: true }`), edit it, compose again with
the `fileId`. If the newest version is the owner's own (he typed numbers in
Excel and saved), read it with `artifacts.text` first: it gives his sheets
as CSV with the values his app saved. Carry the inputs he changed into the
program's data — the yellow cells — and never copy a formula's result into
it as a number. Tell him, then compose with `confirmedRebuild: true`.

## Before you show it

Compose with `dryRun: true` and read `render.sheets`:

- every formula in `formulas` has the value you expect: read the totals;
- `errors` is empty — no `#NAME?`, `#REF!`, `#DIV/0!`, and no formula
  without a value;
- the header row is frozen (`frozen.rows` is 1) and every column has a width;
- `numberFormats` covers every number column; inputs are marked;
- sheet names are short and the Summary sheet comes first.

Fix what is off and compose for real once. After two failed runs, write the
table with `artifacts.write` format `xlsx`, the numbers worked out as
values, and tell the owner the sheet has no formulas.
