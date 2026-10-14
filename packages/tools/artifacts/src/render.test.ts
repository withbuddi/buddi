import { describe, expect, it } from 'vitest';
import { readWorkbookParts } from '@buddi/core/sheet';
import { xlsxRender } from './render.js';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const parts = (sheetData: string, after = ''): Record<string, string> => ({
  'xl/workbook.xml': `<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<worksheet ${NS}><sheetData>${sheetData}</sheetData>${after}</worksheet>`,
});

describe('a workbook said in words', () => {
  it('lists a formula or a conditional rule stored with its = as an error, so a fill that leaves one fails its check', () => {
    const cf = '<conditionalFormatting sqref="A2:B3"><cfRule type="expression" dxfId="0" priority="1"><formula>=$A2&gt;1</formula></cfRule></conditionalFormatting>';
    const render = xlsxRender(readWorkbookParts(parts('<row r="1"><c r="A1"><f>=1+1</f><v>2</v></c><c r="B1"><f>1+2</f><v>3</v></c></row>', cf)), null);
    expect(render.sheets[0]!.errors).toEqual([
      { cell: 'A1', formula: '=1+1', error: "stored with a leading '=' in the file, which Numbers does not open" },
      { cell: 'A2', formula: '=$A2>1', error: "conditional rule stored with a leading '=' in the file, which Numbers does not open" },
    ]);
  });
});
