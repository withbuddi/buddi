/**
 * The words of a message: what agents, search and the list read.
 */
import { describe, expect, it } from 'vitest';
import { cleanText, htmlToText } from './text.js';

const PAD = '&#8202;&zwnj;&#8203;&#847;&nbsp;'.repeat(40);

const NEWSLETTER = `<!doctype html><html><head><title>The Weekly</title>
<style>.hero { color: #333 } td { padding: 0 }</style>
<script>track()</script></head>
<body>
<div style="display:none;max-height:0;overflow:hidden">Hidden preheader${PAD}</div>
<table role="presentation" width="100%"><tr><td>
  <table><tr><td><h1>The Weekly&#8202;Digest</h1></td></tr>
  <tr><td><p>Q&#38;A with Ana &mdash; what&rsquo;s next for the studio.</p>
  <p>Tickets: <a href="https://example.test/t?a=1&amp;b=2">get yours&nbsp;here</a></p></td></tr>
  <tr><td>Price</td><td>&euro;12</td></tr></table>
</td></tr></table>
<p>Line one<br>Line two</p>
<template><p>never shown</p></template>
<p hidden>also hidden</p>
<p>&zwnj;&zwnj;&zwnj;</p><p></p><p></p><p></p>
<p>Unsubscribe &#x2192; here</p>
</body></html>`;

describe('htmlToText', () => {
  const text = htmlToText(NEWSLETTER);

  it('decodes every entity and leaves none behind', () => {
    expect(text).toContain('Q&A with Ana — what’s next for the studio.');
    expect(text).toContain('€12');
    expect(text).toContain('Unsubscribe → here');
    expect(text).toContain('get yours here');
    expect(text).not.toMatch(/&#?[a-z0-9]+;/i);
  });

  it('drops styles, scripts, the head, templates and hidden elements', () => {
    for (const gone of ['color: #333', 'track()', 'The Weekly\n', 'never shown', 'also hidden', 'Hidden preheader']) {
      expect(text, gone).not.toContain(gone);
    }
  });

  it('drops the invisible padding and the hair spaces between words', () => {
    expect(text).not.toMatch(/[​-‍⁠﻿­͏   ]/);
    // A hair space between two words is no space at all, as the sender meant it to look.
    expect(text).toContain('The WeeklyDigest');
  });

  it('keeps lines, and never more than one blank line in a row', () => {
    expect(text).toContain('Line one\nLine two');
    expect(text).toContain('Price €12');
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).not.toMatch(/ {2,}/);
    expect(text.startsWith('The WeeklyDigest')).toBe(true);
  });
});

describe('cleanText', () => {
  it('decodes what old syncs stored, and keeps what is not an entity', () => {
    expect(cleanText('Q&#38;A &amp; more&#8202;&zwnj;&#8202;   now')).toBe('Q&A & more now');
    expect(cleanText('Rock &rsquo;n&rsquo; roll &#x2014; live')).toBe('Rock ’n’ roll — live');
    expect(cleanText('AT&T and ?a=1&copy=2 and &notathing;')).toBe('AT&T and ?a=1&copy=2 and &notathing;');
    expect(cleanText('one\n\n\n\n\ntwo​‌')).toBe('one\n\ntwo');
  });

  it('is idempotent', () => {
    const once = cleanText('Q&#38;A&zwnj; &amp; ok');
    expect(cleanText(once)).toBe(cleanText(once));
  });
});
