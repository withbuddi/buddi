/**
 * Settings → Memory → People: the list with the next date and the reminder
 * bell, the sheet (dates, the reminder switch greyed until a date is set),
 * forget with Undo, and the cards proposing people with Keep all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Toast from '@radix-ui/react-toast';
import { api, type PersonRow, type ProposalRow } from '../api';
import { People, nextWords } from './People';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      people: vi.fn(), savePerson: vi.fn(), forgetPerson: vi.fn(), restorePerson: vi.fn(),
      proposals: vi.fn(), keepProposal: vi.fn(), discardProposal: vi.fn(), keepAllProposals: vi.fn(),
    },
  };
});

const person = (over: Partial<PersonRow>): PersonRow => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'Ben', relationship: 'brother', addressAs: null,
  birthday: { day: 9, month: 10, year: 1991 }, anniversary: null, notes: 'Into cycling.', createdBy: 'owner', updatedAt: null,
  next: { what: 'birthday', inDays: 6, turning: 35 }, reminders: false, ...over,
});
const CLAIRE = person({ id: '22222222-2222-4222-8222-222222222222', name: 'Claire', relationship: 'accountant', birthday: null, next: null, reminders: null, notes: null });
const card = (id: string, name: string): ProposalRow => ({
  id, kind: 'policy', agent: 'concierge', why: `Your notes name ${name}.`, payload: { plugin: 'memory', matcher: { person: name }, action: `Remember ${name}: sister.`, kind: 'person' },
  state: 'open', ruleKind: 'person', ruleKindLabel: 'Remember a person',
} as unknown as ProposalRow);

const renderPeople = () => render(<Toast.Provider><People /><Toast.Viewport /></Toast.Provider>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.proposals).mockResolvedValue({ open: [], folded: [] } as never);
});

describe('People', () => {
  it('lists each person with who they are, the next date and the bell when reminders are on', async () => {
    vi.mocked(api.people).mockResolvedValue({ people: [person({ reminders: true }), CLAIRE], today: '2026-10-03' });
    renderPeople();
    const ben = await screen.findByLabelText('Ben: edit');
    expect(within(ben).getByText('brother · born 9 October 1991')).toBeInTheDocument();
    expect(within(ben).getByText('Birthday in 6 days · turns 35')).toBeInTheDocument();
    expect(within(ben).getByLabelText('Reminders on')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Claire: edit')).queryByLabelText('Reminders on')).not.toBeInTheDocument();
  });

  it('says the next date in words', () => {
    expect(nextWords(person({ next: { what: 'anniversary', inDays: 0, turning: 12 }, anniversary: { day: 3, month: 10, year: 2014 } }))).toBe('Anniversary today · 12 years');
    expect(nextWords(person({ next: { what: 'birthday', inDays: 120, turning: null }, birthday: { day: 30, month: 1, year: null } }))).toBe('Birthday 30 January');
  });

  it('adds a person with a birthday; the reminder switch waits for a date', async () => {
    vi.mocked(api.people).mockResolvedValue({ people: [], today: '2026-10-03' });
    vi.mocked(api.savePerson).mockResolvedValue({ person: person({}), people: [person({})] });
    renderPeople();
    expect(await screen.findByText(/Nobody yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add a person' }));
    const sheet = await screen.findByRole('dialog');
    const remind = within(sheet).getByRole('switch', { name: 'Remind me of their dates' });
    expect(remind).toBeDisabled();
    expect(within(sheet).getByText('Add a birthday or an anniversary first.')).toBeInTheDocument();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Ben' } });
    fireEvent.change(within(sheet).getByLabelText('Who they are to you'), { target: { value: 'brother' } });
    fireEvent.change(within(sheet).getByLabelText('Birthday: day'), { target: { value: '9' } });
    fireEvent.change(within(sheet).getByLabelText('Birthday: month'), { target: { value: '10' } });
    expect(remind).toBeEnabled();
    fireEvent.click(remind);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.savePerson).toHaveBeenCalledWith({
      name: 'Ben', relationship: 'brother', addressAs: null, birthday: { day: 9, month: 10, year: null }, anniversary: null, notes: null, reminders: true,
    }));
  });

  it('forgets a person after asking, and brings them back with Undo', async () => {
    vi.mocked(api.people).mockResolvedValue({ people: [person({ reminders: true })], today: '2026-10-03' });
    vi.mocked(api.forgetPerson).mockResolvedValue({ people: [] });
    vi.mocked(api.restorePerson).mockResolvedValue({ people: [person({})] });
    renderPeople();
    fireEvent.click(await screen.findByLabelText('Ben: edit'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Forget…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Forget Ben?' });
    expect(within(confirm).getByText(/the reminders for their dates are removed/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(api.forgetPerson).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.restorePerson).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111'));
  });

  it('shows the people agents and notes proposed, with Keep, Not a person and Keep all', async () => {
    vi.mocked(api.people).mockResolvedValue({ people: [], today: '2026-10-03' });
    vi.mocked(api.proposals).mockResolvedValue({ open: [card('p1', 'Lena'), card('p2', 'Paul')], folded: [] } as never);
    vi.mocked(api.keepAllProposals).mockResolvedValue({ kept: 2, failed: 0, skipped: 0, note: '' });
    vi.mocked(api.discardProposal).mockResolvedValue({ proposal: card('p1', 'Lena') });
    renderPeople();
    expect(await screen.findByText('2 people to keep?')).toBeInTheDocument();
    expect(screen.getByText('Remember Lena: sister.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Not a person' })[0]!);
    await waitFor(() => expect(api.discardProposal).toHaveBeenCalledWith('p1', 'Not a person'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep all (2)' }));
    await waitFor(() => expect(api.keepAllProposals).toHaveBeenCalledWith(['p1', 'p2']));
  });
});
