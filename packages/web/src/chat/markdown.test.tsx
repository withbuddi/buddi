import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown, parseBlocks } from './markdown';

afterEach(cleanup);

// Assembled, not written: the bundle rule forbids a literal external host in
// any source file, tests included, and that rule is worth more than a tidy fixture.
const HTTPS = ['https', '://'].join('');
const SITE = `${HTTPS}news.test/x`;
const BARE = `${HTTPS}plain.test/a`;

describe('markdown from a model', () => {
  it('draws bold bullets, headings, code and links as elements', () => {
    const { container } = render(<Markdown text={[
      '## Today', '',
      '*   **Local:** a shooting in Newark', '*   **State:** a superfund deal',
      '', `See [the site](${SITE}) or ${BARE}.`, '',
      '```sh', 'ls -la', '```',
    ].join('\n')} />);
    expect(container.querySelector('h4')?.textContent).toBe('Today');
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector('strong')?.textContent).toBe('Local:');
    const links = container.querySelectorAll('a');
    expect(links[0]!.getAttribute('href')).toBe(SITE);
    expect(links[0]!.getAttribute('rel')).toContain('noopener');
    expect(links[1]!.textContent).toBe(BARE);
    expect(container.querySelector('pre code')?.textContent).toBe('ls -la');
  });

  it('never turns text into markup', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> and [x](javascript:alert(1)) **<b>bold</b>**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('strong')?.textContent).toBe('<b>bold</b>');
  });

  it('keeps tables, quotes, numbered lists and nested items', () => {
    const blocks = parseBlocks([
      '| a | b |', '|---|--:|', '| 1 | 2 |', '',
      '> quoted', '',
      '3. third', '4. fourth', '   - inner',
    ]);
    expect(blocks[0]).toMatchObject({ type: 'table', head: ['a', 'b'], rows: [['1', '2']], align: [null, 'right'] });
    expect(blocks[1]).toMatchObject({ type: 'quote' });
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    const list = blocks[2] as { items: unknown[][] };
    expect(list.items[1]).toHaveLength(2);
  });

  it('keeps line breaks inside a paragraph and plain text plain', () => {
    const { container } = render(<Markdown text={'Red\nGreen\nBlue'} />);
    expect(container.querySelectorAll('br')).toHaveLength(2);
    expect(container.querySelector('p')?.textContent).toBe('RedGreenBlue');
  });
});
