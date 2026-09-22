/**
 * Which attachment the tool means, and how it finds it again on the server.
 *
 * The name and byte checks have their own file (`../attachments/safety.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { pickAttachment, resolveAgainstFresh } from './attachments.js';
import type { AttachmentInfo } from '../ports.js';

const pdf: AttachmentInfo = {
  filename: 'invoice.pdf',
  mime: 'application/pdf',
  sizeBytes: 1024,
  part: '2',
};
const png: AttachmentInfo = { filename: 'logo.png', mime: 'image/png', sizeBytes: 64, part: '3' };

describe('pickAttachment', () => {
  it('picks by position', () => {
    expect(pickAttachment([pdf, png], { index: 1 }).attachment).toBe(png);
  });

  it('picks by filename, ignoring case, space and the characters a name may hide', () => {
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

describe('resolveAgainstFresh', () => {
  it('finds the stored entry by its part id, whatever order the server lists in', () => {
    // The bug this exists for: the fresh listing is the server walking its own
    // tree and owes the stored row no particular order. Resolving `index`
    // against it saves the wrong file under the right name.
    const fresh = [png, pdf];
    expect(resolveAgainstFresh(pdf, fresh)).toBe(pdf);
    expect(resolveAgainstFresh(png, fresh)).toBe(png);
  });

  it('prefers the part id over a name that moved', () => {
    const renamed = { ...pdf, filename: 'september.pdf' };
    expect(resolveAgainstFresh(pdf, [png, renamed])).toBe(renamed);
  });

  it('falls back to filename and size for a row with no usable part id', () => {
    const stored = { ...pdf, part: null };
    expect(resolveAgainstFresh(stored, [png, pdf])).toBe(pdf);
    // A stored part id that is not a part id is not trusted either.
    expect(resolveAgainstFresh({ ...pdf, part: 'TEXT' }, [png, pdf])).toBe(pdf);
  });

  it('refuses to guess between two files of the same name and size', () => {
    const twin = { ...pdf, part: '5' };
    expect(resolveAgainstFresh({ ...pdf, part: null }, [pdf, twin])).toBeNull();
  });

  it('answers null when the part is simply no longer there', () => {
    expect(resolveAgainstFresh(pdf, [png])).toBeNull();
    expect(resolveAgainstFresh(pdf, [])).toBeNull();
  });

  it('does not match on a size that changed under the same name', () => {
    const stored = { ...pdf, part: null };
    expect(resolveAgainstFresh(stored, [{ ...pdf, sizeBytes: 2048 }])).toBeNull();
  });
});
