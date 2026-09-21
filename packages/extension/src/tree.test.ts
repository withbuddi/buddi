/**
 * @vitest-environment jsdom
 *
 * The observation the model reads. What matters here is parity with the
 * Playwright driver: the same roles, the same names, refs only on things that
 * can be acted on, and a tree that quotes the name beside the ref.
 */
import { describe, expect, it } from 'vitest';
import { accessibleName, collect, roleOf, MAX_TARGETS } from './tree.js';

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe('roles and names', () => {
  it('reads the roles the driver reads', () => {
    const doc = page('<a href="/x">Home</a><button>Go</button><input type="checkbox"><input type="text"><select></select><textarea></textarea><div role="tab">One</div>');
    const roles = Array.from(doc.body.children).map(roleOf);
    expect(roles).toEqual(['link', 'button', 'checkbox', 'textbox', 'combobox', 'textbox', 'tab']);
  });

  it('prefers aria-label, then the label, then the placeholder', () => {
    const doc = page('<input id="a" aria-label="Search" placeholder="Type here"><label for="b">Email</label><input id="b"><input id="c" placeholder="City">');
    expect(accessibleName(doc.getElementById('a')!)).toBe('Search');
    expect(accessibleName(doc.getElementById('b')!)).toBe('Email');
    expect(accessibleName(doc.getElementById('c')!)).toBe('City');
  });

  it('collapses whitespace in the text of a link', () => {
    const doc = page('<a href="/x">  Read\n  the docs </a>');
    expect(accessibleName(doc.body.firstElementChild!)).toBe('Read the docs');
  });
});

describe('collect', () => {
  it('hands out one ref per interactive element, in document order', () => {
    const result = collect(page('<main><a href="https://example.test/one">One</a><button>Two</button><p>Just words</p><input aria-label="Three"></main>'));
    expect(result.elements.map((element) => [element.id, element.role, element.name])).toEqual([
      ['l1', 'link', 'One'], ['l2', 'button', 'Two'], ['l3', 'textbox', 'Three'],
    ]);
    expect(result.elements[0]?.href).toBe('https://example.test/one');
    expect(result.nodes[1]?.tagName).toBe('BUTTON');
  });

  it('writes the ref beside the role and name in the tree', () => {
    const result = collect(page('<main><a href="/x">One</a></main>'));
    expect(result.tree).toContain('- link "One" [ref=l1]');
    expect(result.tree).toContain('- main');
  });

  it('keeps text that is not a control', () => {
    const result = collect(page('<main><p>Just words</p></main>'));
    expect(result.tree).toContain('- text: Just words');
  });

  it('skips what the owner cannot see or press', () => {
    const result = collect(page('<main><button disabled>No</button><a href="/x" hidden>Hidden</a><button aria-hidden="true">Quiet</button><button style="display:none">Gone</button><button>Yes</button></main>'));
    expect(result.elements.map((element) => element.name)).toEqual(['Yes']);
  });

  it('never reads a script or a style into the tree', () => {
    const result = collect(page('<main><script>var secret = 1;</script><style>body{color:red}</style><button>Yes</button></main>'));
    expect(result.tree).not.toContain('secret');
    expect(result.tree).not.toContain('color:red');
  });

  it('stops at the same cap as the driver', () => {
    const many = Array.from({ length: MAX_TARGETS + 20 }, (_, index) => `<button>b${index}</button>`).join('');
    const result = collect(page(`<main>${many}</main>`));
    expect(result.elements).toHaveLength(MAX_TARGETS);
    expect(result.nodes).toHaveLength(MAX_TARGETS);
  });

  it('reports where the page is scrolled to', () => {
    const result = collect(page('<main><button>Yes</button></main>'));
    expect(result.scroll).toEqual({ x: 0, y: 0 });
  });
});
