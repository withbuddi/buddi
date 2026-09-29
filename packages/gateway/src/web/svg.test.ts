/**
 * The market icon sanitiser: an allowlist that re-writes what it keeps, and
 * refuses a whole icon over one element it does not know.
 */
import { describe, expect, it } from 'vitest';
import { MAX_ICON_BYTES, sanitizeIconSvg } from './svg.js';

const WEATHER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="3.5"/><path d="M9 2v1.5M9 14.5V16M2 9h1.5M14.5 9H16M4 4l1 1M13 4l-1 1"/><path d="M11 20h8a3 3 0 0 0 0-6 4 4 0 0 0-7.7-1"/></svg>';

describe('sanitizeIconSvg', () => {
  it('keeps a market icon exactly as it draws', () => {
    expect(sanitizeIconSvg(WEATHER)).toBe(WEATHER);
  });

  it('keeps groups, lines and polygons, and takes an XML prolog and comments off', () => {
    const icon =
      '<?xml version="1.0"?>\n<!-- drawn by hand -->\n<svg viewBox="0 0 20 20">\n  <g stroke="currentColor"><line x1="1" y1="2" x2="3" y2="4"/><polyline points="1,2 3,4"/><polygon points="0 0 5 5 0 5"></polygon><rect x="1" y="1" width="4" height="4" rx="1" ry="1"/></g>\n</svg>\n';
    expect(sanitizeIconSvg(icon)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><g stroke="currentColor"><line x1="1" y1="2" x2="3" y2="4"/><polyline points="1,2 3,4"/><polygon points="0 0 5 5 0 5"></polygon><rect x="1" y="1" width="4" height="4" rx="1" ry="1"/></g></svg>',
    );
  });

  it('drops an attribute that is not on the list, or whose value is more than a drawing', () => {
    const out = sanitizeIconSvg(
      `<svg viewBox="0 0 24 24" onload="alert(1)" class="x" style="color:red"><path d="M1 1h2" fill="url(#g)" stroke='javascript:x' data-x="1" onclick="y()"/><circle r="2" cx="&#49;" cy="3"/></svg>`,
    );
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h2"/><circle r="2" cy="3"/></svg>');
  });

  it.each([
    ['a script', '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>'],
    ['a style sheet', '<svg><style>*{}</style></svg>'],
    ['a use', '<svg><use href="#a"/></svg>'],
    ['an image', '<svg><image href="https://x.test/a.png"/></svg>'],
    ['a foreign object', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['text', '<svg><path d="M1 1"/>hello</svg>'],
    ['a doctype', '<!DOCTYPE svg [<!ENTITY a "b">]><svg/>'],
    ['something after the root', '<svg/><script>x()</script>'],
    ['two roots', '<svg></svg><svg></svg>'],
    ['a root that is not svg', '<g><path d="M1 1"/></g>'],
    ['an svg inside an svg', '<svg><svg/></svg>'],
    ['tags that do not close', '<svg><g><path d="M1 1"/></svg>'],
    ['a tag that is not a tag', '<svg><path d="M1 1" / </svg>'],
    ['HTML', '<div>not an icon</div>'],
    ['nothing', ''],
  ])('refuses the whole icon over %s', (_what, input) => {
    expect(sanitizeIconSvg(input)).toBeUndefined();
  });

  it('refuses an icon too large to be one', () => {
    const big = `<svg>${'<path d="M1 1"/>'.repeat(MAX_ICON_BYTES / 10)}</svg>`;
    expect(sanitizeIconSvg(big)).toBeUndefined();
  });
});
