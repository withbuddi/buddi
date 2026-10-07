import { readReference } from '../chat/reference';
/**
 * Host API 1.27's News page grammar, drawn: the `stories` feed (cards under
 * group heads with See all, the ⋯ ways out that hide a card behind its
 * sentence and Undo, the sheet with its sources linked out and how it moved,
 * the empty states), a page's head actions, chips with an add chip and a tab
 * kept in a page parameter, a quiet notice with its link, and a source row's
 * logo, tag, status line and ⋯ menu. Every picture is buddi's own path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { PluginPage } from './PluginPage';
import type { PluginPageDescriptor } from './types';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { pages: vi.fn(), pageQuery: vi.fn(), pageAct: vi.fn(), approval: vi.fn(), approvals: vi.fn(), decide: vi.fn() },
}));

const ECOWAS = {
  id: 'ecowas',
  title: 'ECOWAS leaders open a two-day summit in Lomé',
  lead: 'Closing statement expected Sunday.',
  summary: 'Trade corridors top the agenda.',
  titleAttribution: 'Headline from RFI Afrique',
  summaryAttribution: 'Feed excerpt from Reuters',
  updateAttribution: 'Feed excerpt from Jeune Afrique',
  update: 'Ghana proposes a common customs window by 2028.',
  ago: '4 h ago',
  languages: 'EN · FR',
  mark: { kind: 'new', text: 'New since this morning' },
  outlets: [
    { id: 'rfi.fr', name: 'RFI Afrique', logo: 'rfi.fr' },
    { id: 'jeuneafrique.com', name: 'Jeune Afrique', logo: 'jeuneafrique.com' },
    { id: 'republicoftogo.com', name: 'République togolaise' },
    { id: 'reuters.com', name: 'Reuters', logo: 'reuters.com' },
  ],
  group: { id: 'togo', name: 'Togo & West Africa' },
  kicker: 'Togo & West Africa',
  meta: 'First seen 06:10 · 4 sources · told you this morning',
  told: true,
  sources: [
    { title: 'Sommet de la CEDEAO à Lomé', url: 'https://www.rfi.fr/fr/afrique/x', outlet: 'RFI Afrique', logo: 'rfi.fr', meta: 'RFI Afrique · French · 06:10' },
    { title: 'A bad link', url: 'javascript:alert(1)', outlet: 'Reuters', logo: 'reuters.com', meta: 'Reuters · English · 08:20' },
  ],
  timeline: [
    { at: '06:10', text: 'Earliest collected coverage: RFI Afrique.' },
    { at: '07:30', text: 'Told you in the morning edition.', told: true },
  ],
};
const OPINION = {
  id: 'op-ai',
  title: 'We are measuring AI with the wrong rulers',
  lead: 'Benchmarks reward tests a model has seen.',
  ago: '4 h ago',
  opinion: true,
  quiet: true,
  mark: { kind: 'told', text: 'Told you · this morning' },
  outlets: [{ id: 'economist.com', name: 'The Economist', logo: 'economist.com' }],
  group: { id: 'ai', name: 'AI' },
};

const STORIES = {
  kind: 'stories',
  query: { query: 'stories', params: { topic: { param: 'topic' }, filter: { param: 'filter' } } },
  rows: 'stories',
  groups: { param: 'topic' },
  ways: [
    {
      tool: 'news.hide_story', label: 'Not interested', hint: 'Hides it and shows fewer like it', hides: true,
      args: { id: { row: 'id' }, action: { const: 'not_interested' } }, done: 'Hidden. You’ll see fewer like it.',
      undo: { tool: 'news.hide_story', label: 'Undo', args: { id: { row: 'id' }, action: { const: 'undo' } } },
    },
    {
      tool: 'news.mute_outlet', label: 'Mute {name}', group: 'Mute an outlet', each: 'outlets', hides: true,
      args: { outlet: { item: 'id' }, muted: { const: true } }, done: 'Muted {name}. Its stories are hidden.',
      undo: { tool: 'news.mute_outlet', label: 'Undo', args: { outlet: { item: 'id' }, muted: { const: false } } },
    },
  ],
  ask: { label: 'Ask Anchor', to: { chat: { const: 'anchor' } }, context: { title: { path: 'title' }, text: { const: 'News story ID: ecowas' }, suggestions: ['Explain this story'] } },
  edition: { label: 'Read the edition', to: { chat: { const: 'anchor' } }, when: { path: 'told', equals: true } },
  emptyStates: [
    { when: { path: 'state', equals: 'told' }, title: 'Anchor has told you all of this', text: { path: 'note' }, actions: [{ label: 'Show all', set: { filter: 'all' } }] },
  ],
};

const page = {
  plugin: 'news',
  id: 'stories',
  title: 'News',
  place: 'rail',
  icon: 'news',
  data: { query: 'overview' },
  actions: [
    { kind: 'link', label: 'Sources', to: { page: 'sources' } },
    { kind: 'link', label: 'Latest edition', to: { chat: { path: 'anchor' } }, tone: 'accent' },
  ],
  body: [
    { kind: 'notice', text: { path: 'lede' } },
    {
      kind: 'tabs',
      param: 'filter',
      pick: {
        param: 'topic', label: 'Topic', look: 'chips', add: { label: 'Topic', to: { page: 'sources' } },
        optionsFrom: { query: { query: 'topics' }, rows: 'topics', value: 'id', label: 'name' },
      },
      tabs: [
        { id: 'all', label: 'All', body: [{ kind: 'notice', look: 'quiet', icon: 'globe', text: { path: 'fetched' }, link: { label: { path: 'failing' }, to: { page: 'sources' } } }, STORIES] },
        { id: 'untold', label: 'Not yet told', body: [STORIES] },
      ],
    },
  ],
} as unknown as PluginPageDescriptor;
const sources = { plugin: 'news', id: 'sources', title: 'News', place: 'settings', body: [] } as unknown as PluginPageDescriptor;

function answer(stories: unknown[], extra: Record<string, unknown> = {}): void {
  vi.mocked(api.pageQuery).mockImplementation(async (_plugin, query, params) => {
    if (query === 'overview') return { data: { lede: 'Your sources, grouped into stories.', anchor: 'anchor', fetched: 'Fetched at 10:00 from 31 sources · next at 10:15', failing: '2 aren’t answering' } } as never;
    if (query === 'topics') return { data: { topics: [{ id: 'all', name: 'All' }, { id: 'togo', name: 'Togo & West Africa' }, { id: 'ai', name: 'AI' }] } } as never;
    const topic = (params as Record<string, string> | undefined)?.topic;
    const shown = topic && topic !== 'all' ? stories.filter((s) => (s as { group: { id: string } }).group.id === topic) : stories;
    return { data: { stories: shown, ...extra } } as never;
  });
}

const draw = (navigate = vi.fn()) =>
  render(<PluginPage page={page} item={null} navigate={navigate} timezone="UTC" siblings={[page, sources]} />);

describe('the News page grammar (host API 1.27)', { timeout: 180_000 }, () => {
  afterEach(() => vi.clearAllMocks());

  it('draws the head actions, the chips with their add chip, the quiet line and the cards under their groups', async () => {
    answer([ECOWAS, OPINION]);
    const { container } = draw();
    expect(await screen.findByText('ECOWAS leaders open a two-day summit in Lomé')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sources' })).toHaveAttribute('href', '#/settings/p.news.sources');
    // The intro read from the page's own data, as the page head's one muted line.
    expect(screen.getByText('Your sources, grouped into stories.')).toHaveClass('ui-page-lede');
    expect(screen.getByRole('link', { name: 'Latest edition' })).toHaveAttribute('data-variant', 'accent');
    const chips = within(screen.getByRole('group', { name: 'Topic' }));
    expect(chips.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(chips.getByRole('link', { name: /Topic/ })).toBeInTheDocument();
    expect(screen.getByText('Fetched at 10:00 from 31 sources · next at 10:15', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2 aren’t answering' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Togo & West Africa' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI' })).toBeInTheDocument();
    // Three logos overlapping, a letter tile for the one with none, the rest in words; buddi's paths only.
    expect(screen.getByText('RFI Afrique and 3 more')).toBeInTheDocument();
    const srcs = [...container.querySelectorAll('.pl-story img')].map((img) => img.getAttribute('src'));
    expect(srcs.every((src) => src!.startsWith('/api/plugin-assets/news/'))).toBe(true);
    expect(container.querySelector('.pl-story .pl-logo[data-letter="true"]')).toHaveTextContent('R');
    // The quiet marks: languages, new since; Opinion and told on the other card, drawn quieter.
    expect(screen.getByText('EN · FR')).toBeInTheDocument();
    expect(screen.getByText('New since this morning')).toHaveClass('pl-story-new');
    const opinion = screen.getByText('We are measuring AI with the wrong rulers').closest('article')!;
    expect(opinion).toHaveAttribute('data-opinion', 'true');
    expect(opinion).toHaveAttribute('data-told', 'true');
    expect(within(opinion).getByText('Opinion')).toBeInTheDocument();
  });

  it('See all picks the group, and its head goes with the other groups', async () => {
    answer([ECOWAS, OPINION]);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    draw();
    await screen.findByText('ECOWAS leaders open a two-day summit in Lomé');
    await user.click(within(screen.getByRole('heading', { name: 'AI' }).closest('header')!).getByRole('link', { name: /See all/ }));
    await waitFor(() => expect(screen.queryByText('ECOWAS leaders open a two-day summit in Lomé')).not.toBeInTheDocument());
    expect(within(screen.getByRole('group', { name: 'Topic' })).getByRole('button', { name: 'AI' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('heading', { name: 'AI' })).not.toBeInTheDocument();
    expect(screen.getByText('We are measuring AI with the wrong rulers')).toBeInTheDocument();
  });

  it('a way out hides the card behind its sentence, and Undo calls the way back', async () => {
    answer([ECOWAS, OPINION]);
    vi.mocked(api.pageAct).mockResolvedValue({ result: { ok: true } } as never);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    draw();
    await screen.findByText('ECOWAS leaders open a two-day summit in Lomé');
    await user.click(screen.getByRole('button', { name: 'Ways out for ECOWAS leaders open a two-day summit in Lomé' }));
    expect(await screen.findByText('Mute an outlet')).toBeInTheDocument();
    // Four outlets, four Mute items, each its own name.
    expect(screen.getByRole('menuitem', { name: 'Mute Reuters' })).toBeInTheDocument();
    answer([OPINION]);
    await user.click(screen.getByRole('menuitem', { name: 'Mute Jeune Afrique' }));
    expect(api.pageAct).toHaveBeenCalledWith('news', { tool: 'news.mute_outlet', args: { outlet: 'jeuneafrique.com', muted: true } });
    const gone = await screen.findByRole('status');
    expect(gone).toHaveTextContent('Muted Jeune Afrique. Its stories are hidden.');
    answer([ECOWAS, OPINION]);
    await user.click(within(gone).getByRole('button', { name: 'Undo' }));
    expect(api.pageAct).toHaveBeenLastCalledWith('news', { tool: 'news.mute_outlet', args: { outlet: 'jeuneafrique.com', muted: false } });
    expect(await screen.findByText('ECOWAS leaders open a two-day summit in Lomé')).toBeInTheDocument();
  });

  it('does not repeat the description as an update', async () => {
    answer([{ ...ECOWAS, update: '  Trade corridors top the agenda.  ' }]);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    draw();
    await user.click(await screen.findByText(ECOWAS.title));
    const sheet = await screen.findByRole('dialog');
    expect(sheet).toHaveAttribute('data-scroll-body', 'true');
    expect(sheet.querySelector('.ui-sheet-body .pl-story-sheet')).not.toBeNull();
    expect(sheet.querySelector('.ui-sheet-body .ui-sheet-foot')).toBeNull();
    expect(within(sheet).getAllByText('Trade corridors top the agenda.')).toHaveLength(1);
    expect(sheet.querySelector('.pl-story-sheet-update')).toBeNull();
  });

  it('opens a story in its sheet: the update, the sources linked out, how it moved, and the ways out at its foot', async () => {
    answer([ECOWAS, OPINION]);
    vi.mocked(api.pageAct).mockResolvedValue({ result: { ok: true } } as never);
    const navigate = vi.fn();
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    draw(navigate);
    await user.click(await screen.findByText('ECOWAS leaders open a two-day summit in Lomé'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Togo & West Africa')).toBeInTheDocument();
    expect(within(sheet).getByText('Trade corridors top the agenda.')).toBeInTheDocument();
    expect(within(sheet).getByText('Ghana proposes a common customs window by 2028.', { exact: false })).toBeInTheDocument();
    const out = within(sheet).getByRole('link', { name: /Sommet de la CEDEAO à Lomé/ });
    expect(out).toHaveAttribute('href', 'https://www.rfi.fr/fr/afrique/x');
    expect(out).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(sheet).queryByRole('link', { name: /A bad link/ })).not.toBeInTheDocument();
    expect(within(sheet).getByText('Coverage timeline')).toBeInTheDocument();
    expect(within(sheet).getByText('Headline from RFI Afrique')).toBeInTheDocument();
    expect(within(sheet).getByText('Feed excerpt from Reuters')).toBeInTheDocument();
    expect(within(sheet).getByText('Feed excerpt from Jeune Afrique')).toBeInTheDocument();
    expect(within(sheet).getByText('Told you in the morning edition.').closest('li')).toHaveAttribute('data-told', 'true');
    expect(within(sheet).getByRole('link', { name: 'Read the edition' })).toHaveAttribute('href', '#/chat/anchor');
    expect(within(sheet).getByRole('link', { name: 'Ask Anchor' })).toHaveAttribute('data-variant', 'accent');
    expect(within(sheet).getByRole('link', { name: 'Ask Anchor' })).toHaveAttribute('href', '#/chat/anchor/new');
    await user.click(within(sheet).getByRole('link', { name: 'Ask Anchor' }));
    expect(navigate).toHaveBeenCalledWith('#/chat/anchor/new');
    expect(readReference('anchor')).toEqual({ title: ECOWAS.title, text: 'News story ID: ecowas', suggestions: ['Explain this story'] });
    answer([OPINION]);
    await user.click(within(sheet).getByRole('button', { name: 'Not interested' }));
    expect(api.pageAct).toHaveBeenCalledWith('news', { tool: 'news.hide_story', args: { id: 'ecowas', action: 'not_interested' } });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Hidden. You’ll see fewer like it.')).toBeInTheDocument();
  });

  it('says what the empty feed means, and its button moves the tab back', async () => {
    answer([], { state: 'told', note: 'Anything new lands here first.' });
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    draw();
    await user.click(await screen.findByRole('radio', { name: 'Not yet told' }));
    expect(await screen.findByText('Anchor has told you all of this')).toBeInTheDocument();
    expect(screen.getByText('Anything new lands here first.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true'));
  });

  it('draws a source row with its logo, tag and status, and asks before a menu action that confirms', async () => {
    const list = {
      plugin: 'news',
      id: 'sources',
      title: 'News',
      place: 'settings',
      body: [{
        kind: 'list', query: { query: 'sources' }, rows: 'sources', key: 'id',
        groupBy: { key: 'topicId', label: 'topic', aside: 'aside' },
        item: {
          title: { path: 'name' }, sub: { path: 'line' }, tag: { path: 'lang' },
          logo: { asset: { path: 'logo' }, label: { path: 'name' } },
          status: { text: { path: 'problem' }, tone: { path: 'tone' } },
        },
        actions: [
          { tool: 'news.retry_source', label: 'Try again', args: { id: { row: 'id' } }, when: { path: 'failing', equals: true } },
          { tool: 'news.set_source', label: 'Mute {name}', menu: true, hint: 'Everywhere, not only here', args: { id: { row: 'id' }, muted: { const: true } } },
          { tool: 'news.remove_source', label: 'Remove from {topic}', menu: true, tone: 'danger', confirm: 'Remove {name} from {topic}?', args: { id: { row: 'id' } } },
        ],
      }],
    } as unknown as PluginPageDescriptor;
    vi.mocked(api.pageQuery).mockResolvedValue({
      data: {
        sources: [
          { id: 'rfi', name: 'RFI Afrique', lang: 'FR', line: 'rfi.fr · 41 stories this week', logo: 'rfi.fr', topicId: 'togo', topic: 'Togo & West Africa', aside: '2 sources' },
          { id: 'aa', name: 'AllAfrica', lang: 'EN', line: 'allafrica.com', topicId: 'togo', topic: 'Togo & West Africa', aside: '2 sources', failing: true, problem: 'Failing since Tue 08:00: the feed answers “not found”.', tone: 'warning' },
        ],
      },
    } as never);
    vi.mocked(api.pageAct).mockResolvedValue({ result: { removed: true } } as never);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const { container } = render(<PluginPage page={list} item={null} navigate={vi.fn()} timezone="UTC" siblings={[list]} embedded />);
    expect(await screen.findByText('RFI Afrique')).toBeInTheDocument();
    expect(screen.getByText('Togo & West Africa')).toBeInTheDocument();
    expect(screen.getByText('2 sources')).toHaveClass('pl-group-aside');
    expect(screen.getByText('FR')).toHaveClass('pl-row-tag');
    expect(container.querySelector('.pl-logo-lg img')).toHaveAttribute('src', '/api/plugin-assets/news/rfi.fr?size=64');
    expect(screen.getByText(/Failing since Tue 08:00/)).toHaveAttribute('data-tone', 'warning');
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'More for AllAfrica' }));
    expect(await screen.findByText('Everywhere, not only here')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Remove from Togo & West Africa' }));
    const ask = await screen.findByRole('alertdialog');
    expect(ask).toHaveTextContent('Remove AllAfrica from Togo & West Africa?');
    expect(api.pageAct).not.toHaveBeenCalled();
    await user.click(within(ask).getByRole('button', { name: 'Remove from Togo & West Africa' }));
    expect(api.pageAct).toHaveBeenCalledWith('news', { tool: 'news.remove_source', args: { id: 'aa' } });
  });
});
