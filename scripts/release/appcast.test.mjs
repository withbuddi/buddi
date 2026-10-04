import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { appcast, notesHtml, publishesAppcast, shellOf, signatureAttributes } from './appcast.mjs';

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

  test('names the app shell, and a new item only goes out when the shell changed', () => {
    const live = appcast({ version: '0.1.0-pre.40', file: 'buddi-0.1.0-pre.40.dmg', signature: 'sparkle:edSignature="a" length="1"', notes: '', shell: 1 });
    expect(live).toContain('xmlns:buddi="https://withbuddi.com/xml/appcast"');
    expect(live).toContain('<buddi:shell>1</buddi:shell>');
    expect(shellOf(live)).toBe(1);
    // pre.41 changed only buddi: the live feed stays, the in-app updater offers it.
    expect(publishesAppcast(1, live)).toBe(false);
    // The app itself changed: a Sparkle item.
    expect(publishesAppcast(2, live)).toBe(true);
    // A feed from before the shell was named, or none at all: published, once.
    const old = appcast({ version: '0.1.0-pre.39', file: 'b.dmg', signature: 'sparkle:edSignature="a" length="1"', notes: '' });
    expect(shellOf(old)).toBeUndefined();
    expect(publishesAppcast(1, old)).toBe(true);
    expect(publishesAppcast(1, undefined)).toBe(true);
    expect(publishesAppcast(undefined, live)).toBe(true);
  });

  test('never decides blind: an unreadable live feed fails, only --first-feed means there is none', () => {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'appcast.mjs');
    const dir = mkdtempSync(path.join(tmpdir(), 'appcast-'));
    const dmg = path.join(dir, 'buddi-0.1.0-pre.41.dmg');
    writeFileSync(dmg, 'dmg');
    const run = (...extra) => spawnSync(process.execPath, [script, '0.1.0-pre.41', dmg, 'sparkle:edSignature="a" length="3"', dir, '--shell', '1', ...extra], { encoding: 'utf8' });
    const missing = run('--previous', path.join(dir, 'not-there.xml'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/could not read the live feed/);
    expect(existsSync(path.join(dir, 'appcast.xml'))).toBe(false);
    expect(run().status).toBe(2);
    const live = path.join(dir, 'live.xml');
    writeFileSync(live, appcast({ version: '0.1.0-pre.40', file: 'b.dmg', signature: 'sparkle:edSignature="a" length="1"', notes: '', shell: 1 }));
    expect(run('--previous', live).status).toBe(0);
    expect(existsSync(path.join(dir, 'appcast.xml'))).toBe(false);
    expect(run('--first-feed').status).toBe(0);
    expect(existsSync(path.join(dir, 'appcast.xml'))).toBe(true);
  });
});
