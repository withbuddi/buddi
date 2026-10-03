/**
 * Reports in chat: a news edition drawn as the kit's edition card (from the
 * news plugin's `edition` query, the text behind "Show as text"), and a brief
 * from any other agent keeping its lines.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { MissionReport, isEditionReport, reportView } from './report';
import { editionIdOf, editionOf } from './EditionCard';
import { MessageList } from './MessageList';
import type { ChatMessage } from './types';
import * as Tooltip from '@radix-ui/react-tooltip';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { pageQuery: vi.fn(), pageAct: vi.fn() },
}));

afterEach(() => { cleanup(); vi.mocked(api.pageQuery).mockReset(); vi.mocked(api.pageAct).mockReset(); });

const TEXT = `Morning edition · Sat 3 Oct
Seven stories. West African leaders meet in Lomé today.

### Togo & West Africa

**ECOWAS leaders open a two-day summit in Lomé**

Leaders from the fifteen member states open a two-day summit in Lomé today.

*RFI Afrique and 3 more* · [rfi.fr](https://www.rfi.fr/fr/afrique/cedeao)

— Anchor · next at 12:30`;

const EDITION = {
  edition: {
    id: 'e_abc', kind: 'morning', name: 'Morning edition', when: 'Sat 3 Oct · 07:30',
    lede: 'Seven stories. West African leaders meet in Lomé today.',
    groups: [
      {
        topic: 'Togo & West Africa',
        stories: [
          {
            storyId: 's1', title: 'ECOWAS leaders open a two-day summit in Lomé', lead: 'Leaders from the fifteen member states open a two-day summit in Lomé today.',
            outlet: 'RFI Afrique', more: 3, link: { url: 'https://www.rfi.fr/fr/afrique/cedeao', label: 'rfi.fr' },
            logos: [{ name: 'RFI Afrique', logo: 'rfi.fr' }, { name: 'Reuters' }],
            topicName: 'Togo & West Africa',
            // The plugin's declared ways out, in the page grammar; the card knows none of them by name.
            actions: [
              { tool: 'news.hide_story', label: 'Not interested', hint: 'Hides it and shows fewer like it', args: { id: { const: 's1' }, action: { const: 'not_interested' } }, done: 'Hidden. It won’t come back.', undo: { tool: 'news.hide_story', label: 'Undo', args: { id: { const: 's1' }, action: { const: 'undo' } } } },
              { tool: 'news.mute_outlet', label: 'Mute RFI Afrique', group: 'Mute an outlet', args: { outlet: { const: 'o_rfi' }, muted: { const: true } }, done: 'Muted RFI Afrique. Its stories are hidden.', undo: { tool: 'news.mute_outlet', label: 'Undo', args: { outlet: { const: 'o_rfi' }, muted: { const: false } } } },
              { tool: 'news.mute_outlet', label: 'Mute Reuters', group: 'Mute an outlet', args: { outlet: { const: 'o_reuters' }, muted: { const: true } }, done: 'Muted Reuters. Its stories are hidden.' },
              { tool: 'Bad Tool', label: 'Bad', args: {}, done: 'x' },
              { tool: 'news.mute_outlet', label: 'Raw args', args: { outlet: 'o_x' }, done: 'x' },
              { tool: 'news.set_topic', label: 'Quiet Togo & West Africa for a week', hint: 'Back on its own next Saturday', args: { topic: { const: 'west-africa' }, mutedForHours: { const: 168 } }, done: 'Togo & West Africa is quiet for a week.', undo: { tool: 'news.set_topic', label: 'Undo', args: { topic: { const: 'west-africa' }, mutedForHours: { const: 0 } } } },
              { tool: 'news.set_topic', label: 'Mute Togo & West Africa', hint: 'Undo it in Sources', confirm: 'Mute Togo & West Africa everywhere?', args: { topic: { const: 'west-africa' }, muted: { const: true } }, done: 'Muted Togo & West Africa. Anchor leaves it out too.', undo: { tool: 'news.set_topic', label: 'Undo', args: { topic: { const: 'west-africa' }, muted: { const: false } } } },
            ],
          },
          {
            mark: 'update', markLabel: 'UPDATE', title: 'Ghana raises the cocoa price', lead: 'It takes effect on Monday.', outlet: 'Reuters', more: 0,
            link: { url: 'javascript:alert(1)', label: 'x' }, logos: [],
          },
        ],
      },
      { topic: 'AI', stories: [{ mark: 'opinion', title: 'We are measuring AI wrong', lead: '', outlet: 'The Economist', more: 0, logos: [{ name: 'The Economist' }] }] },
    ],
    notes: ['Voice was off today: the Speech plugin is not installed'],
    next: '12:30',
  },
};

const report = (link: string) => reportView({ urgency: 'normal', text: TEXT }, { delivered: 'queued', link, linkLabel: 'Open edition' });

describe('a news edition in chat', () => {
  it('knows an edition link, and nothing else', () => {
    expect(editionIdOf('#/p/news/stories?edition=e_abc')).toBe('e_abc');
    expect(editionIdOf('#/p/news/stories?topic=ai&edition=e_1')).toBe('e_1');
    expect(editionIdOf('#/p/news/stories')).toBeNull();
    expect(editionIdOf('#/p/news/stories?edition=../x')).toBeNull();
    expect(editionIdOf('#/p/weather/now?edition=e_abc')).toBeNull();
    expect(editionOf({ edition: null })).toBeNull();
    expect(editionOf({ edition: { groups: [{ topic: 'x', stories: [{ title: '' }] }] } })).toBeNull();
  });

  it('draws the card from the plugin: topics, stories, marks, the outlet linked out, logos from buddi only', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: EDITION });
    render(<MissionReport view={report('#/p/news/stories?edition=e_abc')} />);
    const card = await screen.findByTestId('edition-card');
    expect(api.pageQuery).toHaveBeenCalledWith('news', 'edition', { id: 'e_abc' });
    expect(within(card).getByText('Morning edition')).toHaveClass('ed-kicker');
    expect(within(card).getByText('Sat 3 Oct · 07:30')).toBeInTheDocument();
    expect(within(card).getAllByRole('heading').map((h) => h.textContent)).toEqual(['Togo & West Africa', 'AI']);
    const rfi = within(card).getByRole('link', { name: /RFI Afrique/ });
    expect(rfi).toHaveAttribute('href', 'https://www.rfi.fr/fr/afrique/cedeao');
    expect(rfi).toHaveAttribute('target', '_blank');
    expect(rfi).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(card).getByText('and 3 more')).toBeInTheDocument();
    // The logo is buddi's own asset route; an outlet without one is its letter.
    expect(card.querySelector('img')).toHaveAttribute('src', '/api/plugin-assets/news/rfi.fr?size=64');
    expect(card.querySelectorAll('img')).toHaveLength(1);
    // UPDATE and OPINION lead their headlines; a link that is not the web is no link.
    expect(within(card).getByText('Update')).toHaveAttribute('data-kind', 'update');
    expect(within(card).getByText('Opinion')).toHaveClass('ed-mark');
    expect(within(card).queryByRole('link', { name: /Reuters/ })).toBeNull();
    expect(within(card).getByText('Reuters')).toBeInTheDocument();
    expect(within(card).getByText(/Voice was off today: the Speech plugin is not installed Next edition at 12:30\./)).toHaveClass('ed-foot');
    expect(screen.getByRole('link', { name: 'Open edition' })).toHaveAttribute('href', '#/p/news/stories?edition=e_abc');
    // No Markdown left on the card.
    expect(card.textContent).not.toMatch(/[*#]/);
  });

  it('keeps the text one tap away, and shows the text when the plugin has nothing to say', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.pageQuery).mockResolvedValue({ data: EDITION });
    render(<MissionReport view={report('#/p/news/stories?edition=e_abc')} />);
    await screen.findByTestId('edition-card');
    await user.click(screen.getByRole('button', { name: 'Show as text' }));
    expect(screen.queryByTestId('edition-card')).toBeNull();
    const text = screen.getByTestId('mission-report').querySelector('.wb-md')!;
    expect(within(text as HTMLElement).getByRole('heading', { name: 'Togo & West Africa' })).toBeInTheDocument();
    expect(within(text as HTMLElement).getByRole('link', { name: 'rfi.fr' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show as card' }));
    expect(screen.getByTestId('edition-card')).toBeInTheDocument();
    cleanup();

    vi.mocked(api.pageQuery).mockRejectedValue(new Error('not installed'));
    render(<MissionReport view={report('#/p/news/stories?edition=e_gone')} />);
    await waitFor(() => expect(screen.getByTestId('mission-report').querySelector('.wb-md')).not.toBeNull());
    expect(screen.queryByTestId('edition-card')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show as text' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open edition' })).toBeInTheDocument();
  });
});

describe('the ways out on an edition story', () => {
  it('offers the ways the plugin declared for a told story, and none for one the edition did not match', () => {
    const e = editionOf(EDITION)!;
    const [told, stray] = e.groups[0]!.stories;
    const ways = told!.actions!;
    // A tool that is no tool name, or an argument that is no `{ const }`, is left out.
    expect(ways.map((w) => w.label)).toEqual(['Not interested', 'Mute RFI Afrique', 'Mute Reuters', 'Quiet Togo & West Africa for a week', 'Mute Togo & West Africa']);
    expect(ways[0]).toMatchObject({ tool: 'news.hide_story', args: { id: 's1', action: 'not_interested' }, undo: { tool: 'news.hide_story', label: 'Undo', args: { id: 's1', action: 'undo' } } });
    expect(ways[1]).toMatchObject({ tool: 'news.mute_outlet', group: 'Mute an outlet', args: { outlet: 'o_rfi', muted: true }, undo: { args: { outlet: 'o_rfi', muted: false } } });
    expect(ways[2]!.undo).toBeUndefined();
    expect(ways[3]).toMatchObject({ tool: 'news.set_topic', args: { topic: 'west-africa', mutedForHours: 168 }, hint: 'Back on its own next Saturday' });
    expect(ways[4]).toMatchObject({ tool: 'news.set_topic', args: { topic: 'west-africa', muted: true }, confirm: 'Mute Togo & West Africa everywhere?' });
    expect(stray!.actions).toBeUndefined();
  }, 180_000);

  it('asks first when the action declares a question', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.pageQuery).mockResolvedValue({ data: EDITION });
    vi.mocked(api.pageAct).mockResolvedValue({ result: {} });
    render(<MissionReport view={report('#/p/news/stories?edition=e_abc')} />);
    const card = await screen.findByTestId('edition-card');
    await user.click(within(card).getByRole('button', { name: /^Ways out for/ }));
    await user.click(await screen.findByRole('menuitem', { name: /^Mute Togo & West Africa/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Mute Togo & West Africa everywhere?' });
    expect(api.pageAct).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Mute Togo & West Africa' }));
    expect(api.pageAct).toHaveBeenCalledWith('news', { tool: 'news.set_topic', args: { topic: 'west-africa', muted: true } });
    expect(await within(card).findByText('Muted Togo & West Africa. Anchor leaves it out too.')).toBeInTheDocument();
  }, 180_000);

  it('runs the owner tool, leaves the sentence and Undo in the story\'s place, and Undo takes it back', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.pageQuery).mockResolvedValue({ data: EDITION });
    vi.mocked(api.pageAct).mockResolvedValue({ result: {} });
    render(<MissionReport view={report('#/p/news/stories?edition=e_abc')} />);
    const card = await screen.findByTestId('edition-card');
    // Only the told story has a ⋯.
    expect(within(card).getAllByRole('button', { name: /^Ways out for/ })).toHaveLength(1);
    await user.click(within(card).getByRole('button', { name: 'Ways out for ECOWAS leaders open a two-day summit in Lomé' }));
    await user.click(await screen.findByRole('menuitem', { name: /Not interested/ }));
    expect(api.pageAct).toHaveBeenCalledWith('news', { tool: 'news.hide_story', args: { id: 's1', action: 'not_interested' } });
    expect(await within(card).findByText('Hidden. It won’t come back.')).toBeInTheDocument();
    expect(within(card).queryByText('ECOWAS leaders open a two-day summit in Lomé')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Undo' }));
    expect(api.pageAct).toHaveBeenLastCalledWith('news', { tool: 'news.hide_story', args: { id: 's1', action: 'undo' } });
    expect(await within(card).findByText('ECOWAS leaders open a two-day summit in Lomé')).toBeInTheDocument();
  }, 180_000);

  it('draws the edition card without the Mission · Report row above it; another report keeps its row', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: EDITION });
    const turn = (id: string, link: string): ChatMessage[] => [
      { id: `a-${id}`, role: 'assistant', at: '', blocks: [{ type: 'tool_use', id, name: 'mission.report', input: { urgency: 'normal', text: TEXT } }] },
      { id: `u-${id}`, role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: id, name: 'mission.report', ok: true, output: { delivered: 'queued', link, linkLabel: 'Open' } }] },
    ];
    expect(isEditionReport(report('#/p/news/stories?edition=e_abc'))).toBe(true);
    expect(isEditionReport(report('#/p/weather/now'))).toBe(false);
    const { container } = render(<Tooltip.Provider><MessageList messages={turn('t1', '#/p/news/stories?edition=e_abc')} live={[]} now={0} onOpen={() => {}} emptyHint="" /></Tooltip.Provider>);
    await screen.findByTestId('edition-card');
    expect(container.querySelector('.wb-tool-label')).toBeNull();
    cleanup();
    const other = render(<Tooltip.Provider><MessageList messages={turn('t2', '#/p/weather/now')} live={[]} now={0} onOpen={() => {}} emptyHint="" /></Tooltip.Provider>);
    expect(other.container.querySelector('.wb-tool-label')).not.toBeNull();
  }, 180_000);
});

describe('a plain-text brief from any agent', () => {
  // Chief of Staff's morning brief, as its skill writes it: one plain line each, no blank lines.
  const BRIEF = [
    'Morning brief · Sat 3 Oct',
    'Rain from 15:00, take a coat.',
    '09:30 Call with the accountant',
    '14:00 Dentist, rue Garibaldi',
    'Free 10:30 to 13:30 and after 15:00.',
    'Sarah asks if Thursday works for the review.',
    'The insurer wants the signed form by Monday.',
    'Still waiting on the plumber’s quote, 9 days.',
    'First: answer Sarah before the 09:30 call.',
  ].join('\n');

  it('reads as lines, not one paragraph', () => {
    render(<MissionReport view={reportView({ urgency: 'normal', text: BRIEF }, { delivered: 'queued' })} />);
    const bubble = screen.getByTestId('mission-report').querySelector('.wb-bubble')!;
    expect(bubble.querySelectorAll('br')).toHaveLength(8);
    const lines = (bubble as HTMLElement).innerHTML.split('<br>').map((l) => l.replace(/<[^>]+>/g, ''));
    expect(lines).toEqual(BRIEF.split('\n'));
    expect(api.pageQuery).not.toHaveBeenCalled();
  });
});
