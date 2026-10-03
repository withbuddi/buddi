/**
 * Host API 1.27 on the page: a list row's pictures drawn from buddi's own
 * asset route (a letter tile when there is none), a link out opened in a new
 * tab with no opener and no referrer, a widget row's picture on medium, a
 * scheduled report's voice note and link in its conversation, and the news
 * icon. Nothing here reaches a host: every `src` is the dashboard's own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { api } from '../api';
import { PluginPage, outsideHref } from './PluginPage';
import { assetSrc, isAssetSrc } from './AssetImage';
import { pageIcon } from './icons';
import { WidgetBodyView } from '../views/parts/WidgetBody';
import { MissionReport, reportView } from '../chat/report';
import type { PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { pages: vi.fn(), pageQuery: vi.fn(), pageAct: vi.fn(), approval: vi.fn(), approvals: vi.fn(), decide: vi.fn() },
}));

const STORIES = {
  stories: [
    {
      id: 's1',
      title: 'Lomé port traffic rose 9%',
      url: 'https://www.togofirst.com/fr/economie/port',
      outlets: [
        { name: 'Togo First', logo: 'togofirst.com' },
        { name: 'RFI', logo: 'rfi.fr' },
        { name: 'Le Monde', logo: 'https://evil.example/logo.png' },
        { name: 'Africanews', logo: null },
      ],
    },
    { id: 's2', title: 'A story with a bad link', url: 'javascript:alert(1)', outlets: [{ name: 'Reuters', logo: 'reuters.com' }] },
  ],
};

const page: PluginPageDescriptor = {
  plugin: 'news',
  id: 'stories',
  title: 'News',
  place: 'rail',
  icon: 'news',
  body: [
    {
      kind: 'list',
      query: { query: 'stories' },
      rows: 'stories',
      key: 'id',
      item: { title: { path: 'title' }, to: { href: { path: 'url' } }, images: { from: 'outlets', asset: 'logo', label: 'name' } },
    },
  ],
} as unknown as PluginPageDescriptor;

describe('host API 1.27 on the page', () => {
  afterEach(() => vi.clearAllMocks());

  it('takes only an absolute https address as a link out', () => {
    expect(outsideHref('https://www.togofirst.com/x')).toBe('https://www.togofirst.com/x');
    for (const bad of ['http://example.com/', 'javascript:alert(1)', '/api/x', '#/p/news', 'https://user:pw@example.com/', 42, null]) {
      expect(outsideHref(bad), String(bad)).toBeNull();
    }
  });

  it('builds an image path only from the plugin and a key, never from a URL', () => {
    expect(assetSrc('news', 'rfi.fr')).toBe('/api/plugin-assets/news/rfi.fr?size=64');
    expect(assetSrc('news', 'https://evil.example/logo.png')).toBeNull();
    expect(assetSrc('news', '../secrets')).toBeNull();
    expect(isAssetSrc('/api/plugin-assets/news/rfi.fr?size=64')).toBe(true);
    expect(isAssetSrc('https://evil.example/x.png')).toBe(false);
    expect(isAssetSrc('//evil.example/x.png')).toBe(false);
  });

  it('draws up to three logos from buddi, a letter for a missing one, the rest in words, and the title linked out', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: STORIES } as never);
    const { container } = render(<PluginPage page={page} item={null} navigate={vi.fn()} timezone="UTC" siblings={[page]} />);
    const title = await screen.findByRole('link', { name: /Lomé port traffic rose 9%/ });
    expect(title).toHaveAttribute('href', 'https://www.togofirst.com/fr/economie/port');
    expect(title).toHaveAttribute('target', '_blank');
    expect(title).toHaveAttribute('rel', 'noopener noreferrer');
    expect(title).toHaveTextContent('(opens in a new tab)');

    const stack = within(screen.getAllByTestId('row-images')[0]!);
    expect(stack.getByText('Togo First and 3 more')).toBeInTheDocument();
    const images = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    // Togo First, RFI, then Reuters on the second row; Le Monde's URL is a letter tile.
    expect(images).toEqual([
      '/api/plugin-assets/news/togofirst.com?size=64',
      '/api/plugin-assets/news/rfi.fr?size=64',
      '/api/plugin-assets/news/reuters.com?size=64',
    ]);
    expect(images.every((src) => src!.startsWith('/api/'))).toBe(true);
    expect(container.querySelectorAll('.pl-stack-logos')[0]!.children).toHaveLength(3);
    expect(container.querySelector('.pl-logo[data-letter="true"]')).toHaveTextContent('L');

    // A value that is not an https address is no link at all.
    expect(screen.queryByRole('link', { name: /A story with a bad link/ })).not.toBeInTheDocument();
    expect(screen.getByText('A story with a bad link')).toBeInTheDocument();
  });

  it('draws a link component that leaves buddi as a button opening a new tab', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: STORIES } as never);
    const detail = {
      ...page,
      body: [{ kind: 'detail', query: { query: 'stories' }, fields: [], body: [{ kind: 'link', label: 'Read the article', to: { href: { path: 'stories[0].url' } } }] }],
    } as unknown as PluginPageDescriptor;
    render(<PluginPage page={detail} item={null} navigate={vi.fn()} timezone="UTC" siblings={[detail]} />);
    const button = await screen.findByRole('link', { name: /Read the article/ });
    expect(button).toHaveAttribute('href', 'https://www.togofirst.com/fr/economie/port');
    expect(button).toHaveAttribute('target', '_blank');
    expect(button).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('draws a widget row\'s picture at both sizes, and only from buddi', () => {
    const body = {
      kind: 'list' as const,
      rows: [
        { title: 'Lomé port traffic rose 9%', image: { src: '/api/plugin-assets/news/togofirst.com?size=64' } },
        { title: 'A row with a stranger\'s picture', image: { src: 'https://evil.example/x.png' } },
      ],
    };
    const { container, unmount } = render(<WidgetBodyView body={body} size="medium" />);
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['/api/plugin-assets/news/togofirst.com?size=64']);
    expect(container.querySelectorAll('.wg-mark')).toHaveLength(2);
    unmount();
    // The kit's small Top stories leads each headline with its outlet's logo too.
    const small = render(<WidgetBodyView body={body} size="small" />);
    expect(small.container.querySelectorAll('.wg-mark')).toHaveLength(2);
  });

  it('draws five denser rows at medium when a list asks, three at small, and two-line titles with wrap', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ title: `Story ${i + 1}`, side: `Outlet · ${i + 1} h` }));
    const medium = render(<WidgetBodyView body={{ kind: 'list', max: 5, rows }} size="medium" />);
    expect(medium.container.querySelectorAll('.wg-row')).toHaveLength(5);
    expect(medium.container.querySelector('.wg-list')).toHaveAttribute('data-dense', 'true');
    medium.unmount();
    const small = render(<WidgetBodyView body={{ kind: 'list', max: 5, wrap: true, rows }} size="small" />);
    expect(small.container.querySelectorAll('.wg-row')).toHaveLength(3);
    expect(small.container.querySelector('.wg-list')).toHaveAttribute('data-wrap', 'true');
    expect(small.container.querySelector('.wg-list')).not.toHaveAttribute('data-dense');
    small.unmount();
    const plain = render(<WidgetBodyView body={{ kind: 'list', rows }} size="medium" />);
    expect(plain.container.querySelectorAll('.wg-row')).toHaveLength(3);
  });

  it('draws a scheduled report as it was sent: the voice note above the text, the link under it', () => {
    const view = reportView(
      { urgency: 'normal', text: 'Morning edition · Sat 3 Oct\n\nSix stories from 15 outlets.' },
      {
        delivered: 'queued', chars: 52, link: '#/p/news/stories', linkLabel: 'Open edition',
        audio: { fileId: '7c1b0a52-6f0e-4b8e-9d55-1e0f2a3b4c5d', mime: 'audio/ogg', filename: 'edition.ogg', sizeBytes: 4096 },
      },
    );
    render(<MissionReport view={view} />);
    const report = screen.getByTestId('mission-report');
    expect(report.firstElementChild).toHaveTextContent('edition.ogg');
    expect(within(report).getByText(/Six stories from 15 outlets/)).toBeInTheDocument();
    expect(within(report).getByRole('link', { name: 'Open edition' })).toHaveAttribute('href', '#/p/news/stories');
    // A web address is no button, and a file that is not audio no player.
    expect(reportView({ text: 'x' }, { link: 'https://example.com', audio: { fileId: 'not-an-id', mime: 'audio/ogg' } })).toEqual({ text: 'x', link: null, audio: null });
  });

  it('wears the news icon in the rail', () => {
    expect(pageIcon('news')).toBe('news');
  });
});
