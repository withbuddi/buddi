#!/usr/bin/env node
/**
 * buddi.app's Sparkle feed and the download pointer, written by the `mac-app`
 * job in .github/workflows/release.yml after the DMG is notarized and signed.
 *
 *   node scripts/release/appcast.mjs <version> <dmg> "<sign_update output>" <out-dir>
 *
 * writes `<out-dir>/appcast.xml` (one item: this release, its notes as simple
 * HTML for Sparkle's dialog) and `<out-dir>/latest.json`
 * (`{ version, file, sha256, bundleVersion }`, what withbuddi.com/download/mac
 * redirects by). The notes are the version's CHANGELOG.md section, the same
 * text the GitHub release carries.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleVersion } from './bundle-version.mjs';
import { CHANGELOG, sectionOf } from './changelog.mjs';

/** Where the site serves what this job uploads to R2 (buddi-site's worker). */
export const SITE = 'https://withbuddi.com';
/** The oldest macOS buddi.app runs on (project.yml's deploymentTarget). */
export const MINIMUM_SYSTEM = '14.0';

const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A changelog section (### headings, - items, plain lines) as the little HTML Sparkle shows. */
export function notesHtml(markdown) {
  const out = [];
  let list = false;
  const inline = text => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const text = line.trim();
    if (text.startsWith('### ')) {
      if (list) { out.push('</ul>'); list = false; }
      out.push(`<h3>${inline(text.slice(4))}</h3>`);
    } else if (/^[-*] /.test(text)) {
      if (!list) { out.push('<ul>'); list = true; }
      out.push(`<li>${inline(text.slice(2))}</li>`);
    } else if (list && /^\s{2,}\S/.test(line)) {
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${inline(text)}</li>`);
    } else if (text !== '') {
      if (list) { out.push('</ul>'); list = false; }
      out.push(`<p>${inline(text)}</p>`);
    }
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

/**
 * `sign_update` prints the enclosure attributes itself:
 * `sparkle:edSignature="…" length="…"`. Only those two are let through.
 */
export function signatureAttributes(output) {
  const signature = /sparkle:edSignature="([A-Za-z0-9+/=]+)"/.exec(output)?.[1];
  const length = /length="(\d+)"/.exec(output)?.[1];
  if (signature === undefined || length === undefined) throw new Error(`sign_update printed no signature: ${output.trim().slice(0, 200)}`);
  return `sparkle:edSignature="${signature}" length="${length}"`;
}

export function appcast({ version, file, signature, notes, pubDate = new Date().toUTCString() }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>buddi</title>
    <link>${SITE}/appcast.xml</link>
    <item>
      <title>buddi ${escape(version)}</title>
      <sparkle:version>${bundleVersion(version)}</sparkle:version>
      <sparkle:shortVersionString>${escape(version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${MINIMUM_SYSTEM}</sparkle:minimumSystemVersion>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[
${notes.replace(/]]>/g, ']]&gt;')}
      ]]></description>
      <enclosure url="${SITE}/download/mac/${encodeURIComponent(file)}" ${signatureAttributes(signature)} type="application/octet-stream"/>
    </item>
  </channel>
</rss>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, dmg, signature, outDir] = process.argv.slice(2);
  if (!version || !dmg || !signature || !outDir) {
    console.error('usage: appcast.mjs <version> <dmg> "<sign_update output>" <out-dir>');
    process.exit(2);
  }
  let section;
  try { section = sectionOf(readFileSync(CHANGELOG, 'utf8'), version); }
  catch { section = `- The notes are on https://github.com/withbuddi/buddi/releases/tag/v${version}`; }
  const bytes = readFileSync(dmg);
  const file = path.basename(dmg);
  writeFileSync(path.join(outDir, 'appcast.xml'), appcast({ version, file, signature, notes: notesHtml(section) }));
  const latest = { version, file, sha256: createHash('sha256').update(bytes).digest('hex'), bundleVersion: bundleVersion(version) };
  writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  console.log(`appcast.xml and latest.json for ${version} (${file}, sha256 ${latest.sha256})`);
}
