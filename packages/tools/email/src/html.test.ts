/**
 * The HTML body as it is stored: re-written from an allow-list, so nothing
 * that runs, posts, frames or styles the page survives the sync.
 */
import { describe, expect, it } from 'vitest';
import { cleanStyle, MAX_STORED_HTML_BYTES, sanitizeEmailHtml } from './html.js';
import { prepareForIngest } from './mail.js';
import type { FetchedMessage } from './ports.js';

const DANGEROUS = `<!doctype html><html><head><style>body{background:url(https://evil.test/x)}</style>
<script>alert(1)</script><link rel="stylesheet" href="https://evil.test/a.css"><meta http-equiv="refresh" content="0;url=https://evil.test"></head>
<body onload="steal()">
<p onclick="steal()" style="color: red; position: fixed; background-image: url(https://evil.test/t.png)">Hello <b>there</b></p>
<a href="javascript:alert(1)">bad link</a> <a href="https://good.test/path?q=1" target="_self" onmouseover="x()">good link</a>
<a href="mailto:ana@studio.test">mail</a>
<form action="https://evil.test/post"><input name="password"><button>Go</button></form>
<iframe src="https://evil.test/frame"></iframe><object data="x.swf"></object><svg><script>alert(2)</script></svg>
<img src="javascript:alert(3)" alt="bad picture"><img src="https://pics.test/hero.png" width="600" alt="Hero" onerror="x()">
<img src="cid:logo@studio" alt="Logo"><div style="width: expression(alert(4)); color: #333">styled</div>
</body></html>`;

describe('sanitizeEmailHtml', () => {
  it('drops what runs, posts, frames and styles, and keeps the words', () => {
    const out = sanitizeEmailHtml(DANGEROUS)!;
    expect(out).toContain('Hello <b>there</b>');
    for (const gone of ['<script', 'alert(', '<style', '<link', '<meta', '<form', '<input', '<button', '<iframe', '<object', '<svg', 'onload', 'onclick', 'onerror', 'onmouseover', 'javascript:', 'expression', 'url(', 'position', 'target=']) {
      expect(out, gone).not.toContain(gone);
    }
    expect(out).toContain('style="color: red"');
    expect(out).toContain('<a href="https://good.test/path?q=1">good link</a>');
    expect(out).toContain('<a href="mailto:ana@studio.test">mail</a>');
    // A link with nowhere safe to go keeps its words and loses the link.
    expect(out).toContain('bad link');
    expect(out).not.toMatch(/<a [^>]*>bad link/);
    // Pictures are addresses, never fetched here; one with a bad source is its alt text.
    expect(out).toContain('<img src="https://pics.test/hero.png" width="600" alt="Hero">');
    expect(out).toContain('<img src="cid:logo@studio" alt="Logo">');
    expect(out).toContain('bad picture');
    expect(out).toContain('style="color: #333"');
  });

  it('keeps the marks of a quoted reply, and only those classes', () => {
    const out = sanitizeEmailHtml(
      '<div class="gmail_quote big-red"><div class="gmail_attr">On Tue, Ana wrote:</div><blockquote type="cite" class="x">Earlier</blockquote></div><div id="divRplyFwdMsg">From: Bo</div>',
    )!;
    expect(out).toContain('<div class="gmail_quote">');
    expect(out).toContain('<div class="gmail_attr">');
    expect(out).toContain('<blockquote type="cite">Earlier</blockquote>');
    expect(out).toContain('<div class="reply-head">From: Bo</div>');
    expect(out).not.toContain('big-red');
  });

  it('escapes text and attribute values on the way out', () => {
    const out = sanitizeEmailHtml('<p title="&quot;><script>x</script>">1 &lt; 2 &amp; 3 &gt; 2</p>')!;
    expect(out).toBe('<p title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;">1 &lt; 2 &amp; 3 &gt; 2</p>');
  });

  it('keeps nothing for an empty body, and nothing over the stored cap', () => {
    expect(sanitizeEmailHtml('')).toBeNull();
    expect(sanitizeEmailHtml('<html><body><div> </div></body></html>')).toBeNull();
    expect(sanitizeEmailHtml(null)).toBeNull();
    const huge = `<p>${'x'.repeat(MAX_STORED_HTML_BYTES + 10)}</p>`;
    expect(sanitizeEmailHtml(huge)).toBeNull();
  });

  it('flattens nesting past the depth cap to its text', () => {
    const deep = '<div>'.repeat(60) + 'deep words' + '</div>'.repeat(60);
    const out = sanitizeEmailHtml(deep)!;
    expect(out).toContain('deep words');
    expect((out.match(/<div>/g) ?? []).length).toBeLessThanOrEqual(34);
  });

  it('refuses every unsafe style value', () => {
    expect(cleanStyle('color: blue; background: url(x); behavior: url(y); font-weight: bold; width: calc(1px)')).toBe(
      'color: blue; font-weight: bold; width: calc(1px)',
    );
    expect(cleanStyle('color: \\72 ed')).toBe('');
  });
});

describe('ingest', () => {
  const fetched = (over: Partial<FetchedMessage>): FetchedMessage => ({
    uid: 1,
    messageId: '<a@b>',
    inReplyTo: null,
    references: [],
    listId: null,
    from: 'Ana@Studio.test',
    to: ['me@example.test'],
    cc: [],
    subject: 'Hi',
    date: null,
    internalDate: null,
    bodyText: 'Hello',
    hasAttachments: false,
    attachments: [],
    flags: [],
    ...over,
  });

  it('stores the HTML sanitised and the display name, and nothing when there is no HTML', () => {
    const ingested = prepareForIngest(fetched({ bodyHtml: '<p>Hello<script>x()</script></p>', fromName: 'Ana Duarte' }));
    expect(ingested.bodyHtml).toBe('<p>Hello</p>');
    expect(ingested.fromName).toBe('Ana Duarte');
    expect(prepareForIngest(fetched({})).bodyHtml).toBeNull();
  });
});
