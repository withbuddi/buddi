/**
 * The Word writer, kept apart from document.ts and loaded only when a Word
 * file is asked for: `docx` reads `globalThis.localStorage` as it loads (its
 * bundled util-deprecate shim), and on Node 25 and later that prints an
 * ExperimentalWarning in every process that imports it.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LineRuleType,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';
import type { Block, Run } from './markdown.js';


function docxRuns(runs: readonly Run[]): ParagraphChild[] {
  return runs.map((run) => {
    const options: IRunOptions = {
      text: run.text,
      ...(run.breakBefore ? { break: 1 } : {}),
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italics: true } : {}),
      ...(run.strike ? { strike: true } : {}),
      ...(run.code ? { font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' } } : {}),
      ...(run.link ? { style: 'Hyperlink' } : {}),
    };
    const text = new TextRun(options);
    return run.link ? new ExternalHyperlink({ link: run.link, children: [text] }) : text;
  });
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT } as const;
const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D0D7DE' };

/** Each ordered list restarts its numbering: one numbering instance per list. */
interface DocxState { ordered: number }

function docxBlocks(blocks: readonly Block[], state: DocxState, level = 0, quote = false): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const indent = quote ? { indent: { left: 400 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D0D7DE', space: 8 } } } : {};
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[block.depth - 1], children: docxRuns(block.runs) }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: docxRuns(block.runs), ...indent }));
        break;
      case 'list': {
        const instance = block.ordered ? ++state.ordered : 0;
        for (const item of block.items) {
          const box = item.checked === undefined ? [] : [new TextRun({ text: item.checked ? '☑ ' : '☐ ' })];
          out.push(new Paragraph({
            children: [...box, ...docxRuns(item.runs)],
            numbering: block.ordered ? { reference: 'ordered', level: Math.min(level, 8), instance } : { reference: 'bullets', level: Math.min(level, 8) },
          }));
          out.push(...docxBlocks(item.children, state, level + 1, quote));
        }
        break;
      }
      case 'table': {
        const columns = block.header.length;
        const row = (cells: readonly Run[][], header: boolean): TableRow => new TableRow({
          tableHeader: header,
          children: Array.from({ length: columns }, (_, i) => new TableCell({
            borders: { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER },
            ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' } } : {}),
            children: [new Paragraph({
              style: 'TableText',
              alignment: ALIGN[block.align[i] ?? 'left'],
              children: docxRuns((cells[i] ?? []).map((r) => (header ? { ...r, bold: true } : r))),
            })],
          })),
        });
        out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(block.header, true), ...block.rows.map((r) => row(r, false))] }));
        out.push(new Paragraph({ children: [] }));
        break;
      }
      case 'code':
        out.push(new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' },
          children: block.text.split('\n').map((line, i) => new TextRun({ text: line, font: 'Consolas', size: 19, ...(i > 0 ? { break: 1 } : {}) })),
        }));
        break;
      case 'quote':
        out.push(...docxBlocks(block.blocks, state, level, true));
        break;
      case 'rule':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D7DE', space: 1 } }, children: [] }));
        break;
    }
  }
  return out;
}

/** Points as Word's units: twentieths of a point for spacing, half points for sizes. */
const pt = (points: number): number => Math.round(points * 20);
const half = (points: number): number => Math.round(points * 2);
/** Spacing before and after, and size, of each heading level (H1 first). */
const HEADING_SPACING: ReadonlyArray<{ before: number; after: number; size: number }> = [
  { before: 18, after: 6, size: 16 },
  { before: 14, after: 4, size: 13 },
  { before: 12, after: 4, size: 12 },
  { before: 10, after: 2, size: 11 },
  { before: 10, after: 2, size: 11 },
  { before: 10, after: 2, size: 11 },
];
const heading = (level: number) => ({
  run: { font: 'Calibri', size: half(HEADING_SPACING[level]!.size), bold: true, color: '1F2328' },
  paragraph: { keepNext: true, keepLines: true, spacing: { before: pt(HEADING_SPACING[level]!.before), after: pt(HEADING_SPACING[level]!.after) } },
});

/**
 * The document's styles, set once on the document rather than on each run:
 * Calibri 11 pt (Word's own default, which Pages and LibreOffice substitute
 * with a metric match), 8 pt after each paragraph and 1.15 lines, headings
 * spaced before and after and kept with what follows, list items close
 * together (contextual spacing), table text single-spaced.
 */
const DOCX_STYLES = {
  default: {
    document: {
      run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Calibri', eastAsia: 'Calibri' }, size: half(11) },
      // `line` is in 240ths of a line: 276 is 1.15.
      paragraph: { spacing: { after: pt(8), line: 276, lineRule: LineRuleType.AUTO } },
    },
    heading1: heading(0),
    heading2: heading(1),
    heading3: heading(2),
    heading4: heading(3),
    heading5: heading(4),
    heading6: heading(5),
    listParagraph: { paragraph: { contextualSpacing: true, spacing: { after: pt(4) } } },
  },
  // A table cell's text: single-spaced, with a little air top and bottom.
  paragraphStyles: [{ id: 'TableText', name: 'Table Text', basedOn: 'Normal', quickFormat: true, paragraph: { spacing: { before: pt(2), after: pt(2), line: 240, lineRule: LineRuleType.AUTO } } }],
};

/** A Markdown document as a Word file, with Word's own heading and list styles. */
export async function blocksToDocx(blocks: readonly Block[], title: string): Promise<Buffer> {
  const levels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (i: number) => string) =>
    Array.from({ length: 9 }, (_, i) => ({ level: i, format, text: text(i), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } }));
  const doc = new Document({
    creator: 'buddi',
    title,
    styles: DOCX_STYLES,
    numbering: {
      config: [
        { reference: 'bullets', levels: levels(LevelFormat.BULLET, (i) => ['•', '◦', '▪'][i % 3]!) },
        { reference: 'ordered', levels: levels(LevelFormat.DECIMAL, (i) => `%${i + 1}.`) },
      ],
    },
    // One-inch margins all round (1440 twips).
    sections: [{ properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children: docxBlocks(blocks, { ordered: 0 }) }],
  });
  return Packer.toBuffer(doc);
}
