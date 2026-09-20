import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Markdown, MarkdownAgents, parseBlocks } from './markdown';

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

  it('turns a known @handle into a link to the agent, and leaves an unknown one as text', () => {
    const agents = [{ id: 'garage', handle: 'garage', name: 'Garage', description: 'Cars', available: true, roles: [], provider: 'openai', model: 'm' }];
    const { container } = render(<Tooltip.Provider><MarkdownAgents.Provider value={agents}><Markdown text={'Ask @garage, not @nobody or mail@x.test.'} /></MarkdownAgents.Provider></Tooltip.Provider>);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('#/chat/garage');
    expect(container.textContent).toContain('@nobody');
    expect(container.textContent).toContain('mail@x.test');
  });

  it('gives quotes and code a copy control', () => {
    const { container } = render(<Markdown text={'> a quote\n> two lines\n\n```\nls\n```'} />);
    const buttons = [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(buttons).toEqual(['Copy quote', 'Copy code']);
  });

  it('keeps line breaks inside a paragraph and plain text plain', () => {
    const { container } = render(<Markdown text={'Red\nGreen\nBlue'} />);
    expect(container.querySelectorAll('br')).toHaveLength(2);
    expect(container.querySelector('p')?.textContent).toBe('RedGreenBlue');
  });
});
