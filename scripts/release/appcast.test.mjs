import { describe, expect, test } from 'vitest';
import { appcast, notesHtml, signatureAttributes } from './appcast.mjs';

describe('the appcast', () => {
  test('carries the display version, the Sparkle number and the signed enclosure', () => {
    const xml = appcast({
      version: '0.1.0-pre.39', file: 'buddi-0.1.0-pre.39.dmg',
      signature: 'sparkle:edSignature="abc+/=" length="123456"\n', notes: '<p>Hi</p>', pubDate: 'Sat, 03 Oct 2026 12:00:00 GMT',
    });
    expect(xml).toContain('<sparkle:version>0.1.0.39</sparkle:version>');
    expect(xml).toContain('<sparkle:shortVersionString>0.1.0-pre.39</sparkle:shortVersionString>');
    expect(xml).toContain('<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>');
    expect(xml).toContain('<enclosure url="https://github.com/withbuddi/buddi/releases/download/v0.1.0-pre.39/buddi-0.1.0-pre.39.dmg" sparkle:edSignature="abc+/=" length="123456" type="application/octet-stream"/>');
  });

  test('takes only the signature and length from sign_update', () => {
    expect(() => signatureAttributes('nothing here')).toThrow(/no signature/);
    expect(signatureAttributes('sparkle:edSignature="x1" length="9" extra="<script>"')).toBe('sparkle:edSignature="x1" length="9"');
  });

  test('turns a changelog section into the little HTML Sparkle shows', () => {
    expect(notesHtml('### Added\n\n- A **Mac** app\n  that updates `buddi`.\n- Two & <three>\n\nA line.')).toBe(
      '<h3>Added</h3>\n<ul>\n<li>A <b>Mac</b> app that updates <code>buddi</code>.</li>\n<li>Two &amp; &lt;three&gt;</li>\n</ul>\n<p>A line.</p>',
    );
  });
});
