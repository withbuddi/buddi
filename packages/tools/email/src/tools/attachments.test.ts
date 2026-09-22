/**
 * The two decisions `email.fetch_attachment` makes before it opens a socket:
 * which attachment is meant, and whether it is one buddi will keep at all.
 */
import { describe, expect, it } from 'vitest';
import { executableRefusal, pickAttachment } from './attachments.js';
import type { AttachmentInfo } from '../ports.js';

const pdf: AttachmentInfo = {
  filename: 'invoice.pdf',
  mime: 'application/pdf',
  sizeBytes: 1024,
  part: '2',
};
const png: AttachmentInfo = { filename: 'logo.png', mime: 'image/png', sizeBytes: 64, part: '3' };

describe('executableRefusal', () => {
  it('refuses by extension, whatever the sender declared the type to be', () => {
    expect(executableRefusal('invoice.pdf.exe', 'application/pdf')).toContain('.exe');
    expect(executableRefusal('SETUP.SCR', 'application/octet-stream')).toContain('.scr');
    expect(executableRefusal('run.js', 'text/plain')).toContain('.js');
  });

  it('refuses by declared type, whatever the file is called', () => {
    expect(executableRefusal('invoice', 'application/x-msdownload')).toContain('program');
    expect(executableRefusal(null, 'application/x-msdownload; name=x')).toContain('program');
  });

  it('says why rather than just no', () => {
    expect(executableRefusal('x.exe', 'application/pdf')).toContain('library');
  });

  it('keeps the documents mail is actually for', () => {
    expect(executableRefusal('invoice.pdf', 'application/pdf')).toBeNull();
    expect(executableRefusal('statement.xlsx', 'application/vnd.ms-excel')).toBeNull();
    expect(executableRefusal(null, 'image/jpeg')).toBeNull();
  });
});

describe('pickAttachment', () => {
  it('picks by position', () => {
    expect(pickAttachment([pdf, png], { index: 1 }).attachment).toBe(png);
  });

  it('picks by filename, ignoring case and surrounding space', () => {
    expect(pickAttachment([pdf, png], { filename: ' Invoice.PDF ' }).index).toBe(0);
  });

  it('refuses an ambiguous filename rather than taking the first', () => {
    expect(() => pickAttachment([pdf, { ...pdf, part: '4' }], { filename: 'invoice.pdf' })).toThrow(
      /name the one you want by `index`/,
    );
  });

  it('says what is there when the name matches nothing', () => {
    expect(() => pickAttachment([pdf], { filename: 'contract.pdf' })).toThrow(/invoice\.pdf/);
  });

  it('says how many there are when the index is past the end', () => {
    expect(() => pickAttachment([pdf], { index: 3 })).toThrow(/1 attachment/);
  });

  it('refuses a message with nothing on it', () => {
    expect(() => pickAttachment([], { index: 0 })).toThrow(/no attachments/);
  });

  it('asks which one when neither index nor filename is given', () => {
    expect(() => pickAttachment([pdf], {})).toThrow(/`index` or `filename`/);
  });
});
