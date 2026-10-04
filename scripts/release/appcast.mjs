#!/usr/bin/env node
/**
 * buddi.app's Sparkle feed and the download pointer, written by the `mac-app`
 * job in .github/workflows/release.yml after the DMG is notarized and signed.
 *
 *   node scripts/release/appcast.mjs <version> <dmg> "<sign_update output>" <out-dir> [--shell <n>] [--previous <appcast.xml>]
 *
 * writes `<out-dir>/latest.json` always, and `<out-dir>/appcast.xml` (one
 * item: this release, its notes as simple HTML for Sparkle's dialog) only when
 * the app itself changed: `--shell` is `apps/mac/SHELL_VERSION` (bumped by
 * hand when anything under apps/mac changes), and `--previous` the feed that
 * is live now. The same shell means the same app with a newer buddi inside,
 * and buddi updates itself from inside the app — a Sparkle item for it would
 * be a second update path offering the same thing. So the live feed keeps its
 * item (the DMG of the last shell change) and only `latest.json` moves, so a
 * new download still gets the newest buddi. And `<out-dir>/latest.json`
 * (`{ version, file, url, sha256, bundleVersion }`, what withbuddi.com/download/mac
 * redirects to). The DMG itself is served from the GitHub release asset (`url`,
 * also the enclosure); R2 holds only these two files. The notes are the
 * version's CHANGELOG.md section, the same text the GitHub release carries.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleVersion } from './bundle-version.mjs';
import { CHANGELOG, sectionOf } from './changelog.mjs';

/** Where the site serves the feed this job uploads to R2 (buddi-site's worker). */
export const SITE = 'https://withbuddi.com';
/** The public repository whose releases carry the DMG (over Wrangler's 300 MiB R2 upload cap). */
export const REPO = 'https://github.com/withbuddi/buddi';

/** The DMG as the GitHub release v<version> serves it: a stable URL that 302s to the asset. */
export const releaseUrl = (version, file) => `${REPO}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
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

/** The namespace of buddi's own element in the feed: the app shell's version. */
export const BUDDI_NS = 'https://withbuddi.com/xml/appcast';

/** The shell version an appcast's item carries, or undefined (a feed from before it did). */
export function shellOf(xml) {
  const found = /<buddi:shell>\s*(\d+)\s*<\/buddi:shell>/.exec(xml ?? '');
  return found ? Number(found[1]) : undefined;
}

/** Does this release get a new appcast item? Only when the app shell changed (or the live feed cannot say). */
export function publishesAppcast(shell, previousXml) {
  if (shell === undefined) return true;
  const live = shellOf(previousXml);
  return live === undefined || live !== shell;
}

export function appcast({ version, file, signature, notes, shell, pubDate = new Date().toUTCString() }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:buddi="${BUDDI_NS}">
  <channel>
    <title>buddi</title>
    <link>${SITE}/appcast.xml</link>
    <item>
      <title>buddi ${escape(version)}</title>
      <sparkle:version>${bundleVersion(version)}</sparkle:version>
      <sparkle:shortVersionString>${escape(version)}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${MINIMUM_SYSTEM}</sparkle:minimumSystemVersion>${shell === undefined ? '' : `
      <buddi:shell>${Number(shell)}</buddi:shell>`}
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[
${notes.replace(/]]>/g, ']]&gt;')}
      ]]></description>
      <enclosure url="${releaseUrl(version, file)}" ${signatureAttributes(signature)} type="application/octet-stream"/>
    </item>
  </channel>
</rss>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const at = argv.indexOf(`--${name}`);
    if (at === -1) return undefined;
    const value = argv[at + 1];
    argv.splice(at, 2);
    return value;
  };
  const shellText = option('shell');
  const previousFile = option('previous');
  const [version, dmg, signature, outDir] = argv;
  if (!version || !dmg || !signature || !outDir) {
    console.error('usage: appcast.mjs <version> <dmg> "<sign_update output>" <out-dir> [--shell <n>] [--previous <appcast.xml>]');
    process.exit(2);
  }
  const shell = shellText === undefined ? undefined : Number(shellText.trim());
  if (shell !== undefined && !(Number.isInteger(shell) && shell > 0)) { console.error(`--shell must be a whole number, not ${shellText}`); process.exit(2); }
  let previous;
  try { previous = previousFile ? readFileSync(previousFile, 'utf8') : undefined; } catch { previous = undefined; }
  let section;
  try { section = sectionOf(readFileSync(CHANGELOG, 'utf8'), version); }
  catch { section = `- The notes are on https://github.com/withbuddi/buddi/releases/tag/v${version}`; }
  const bytes = readFileSync(dmg);
  const file = path.basename(dmg);
  const latest = { version, file, url: releaseUrl(version, file), sha256: createHash('sha256').update(bytes).digest('hex'), bundleVersion: bundleVersion(version) };
  writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
  if (publishesAppcast(shell, previous)) {
    writeFileSync(path.join(outDir, 'appcast.xml'), appcast({ version, file, signature, notes: notesHtml(section), shell }));
    console.log(`appcast.xml and latest.json for ${version} (${file}, sha256 ${latest.sha256}, shell ${shell ?? 'unnamed'})`);
  } else {
    console.log(`latest.json for ${version} (${file}, sha256 ${latest.sha256}); no appcast.xml: the app shell is still ${shell}, and buddi updates itself inside the app`);
  }
}
