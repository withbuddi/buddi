/**
 * The agent sheet's Skills tab: learned skills with their version, provenance
 * and the untrusted mark, a Remove that calls the gateway, and the skills
 * that came from files and plugins shown read-only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { api, type AgentSkillRow } from '../api';
import { AgentSkills } from './parts/AgentSkills';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return { ...original, api: { ...original.api, agentSkills: vi.fn(), removeSkill: vi.fn() } };
});

const LEARNED: AgentSkillRow = {
  name: 'check-a-bank-balance-in-the-browser',
  description: 'When the owner asks for a balance.',
  scope: 'private',
  provenance: 'agent',
  source: 'learning proposal p-2',
  file: '/owner/agents/advisor/skills/check-a-bank-balance-in-the-browser.md',
  body: 'When: When the owner asks for a balance.\n\n1. Open the bank.',
  learned: {
    title: 'Check a bank balance in the browser',
    agent: 'advisor',
    conversation: 'c-1',
    runId: 'run-1',
    turn: 3,
    sources: ['web page bank balance page (page.read)'],
    untrusted: true,
    proposal: 'p-2',
    keptAt: '2026-09-23T12:00:00Z',
    version: 2,
    edited: true,
    versions: [1, 2],
    versionsDir: '/owner/agents/advisor/skills/versions/check-a-bank-balance-in-the-browser',
  },
};

const PLUGIN: AgentSkillRow = {
  name: 'working-in-a-workspace',
  description: 'The loop a developer agent works in.',
  scope: 'private',
  provenance: 'imported',
  source: 'developer@0.1.0',
  file: '/owner/agents/advisor/skills/working-in-a-workspace.md',
  body: '# Working in a workspace',
  learned: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.agentSkills).mockResolvedValue({ agent: 'advisor', writable: true, skills: [LEARNED, PLUGIN] });
  vi.mocked(api.removeSkill).mockResolvedValue({ ok: true, name: LEARNED.name, version: 2, proposal: 'p-2' });
});

describe('the Skills tab', () => {
  it('shows a learned skill with its version, provenance, the untrusted mark and a link back to the proposal', async () => {
    await act(async () => { render(<AgentSkills agentId="advisor" agentName="Advisor" />); });
    const learned = screen.getByRole('heading', { name: 'Learned' }).closest('section')!;
    expect(within(learned).getByText('Check a bank balance in the browser')).toBeInTheDocument();
    expect(within(learned).getByText('v2 · your correction')).toBeInTheDocument();
    expect(within(learned).getByText('untrusted text in view')).toBeInTheDocument();
    expect(within(learned).getByRole('link', { name: 'conversation, turn 3' })).toHaveAttribute('href', '#/activity/conversations/c-1');
    expect(within(learned).getByRole('link', { name: 'the proposal' })).toHaveAttribute('href', '#/settings/proposals');
    expect(within(learned).getByText('web page bank balance page (page.read)')).toBeInTheDocument();
  });

  it('lists the skills from files and plugins read-only', async () => {
    await act(async () => { render(<AgentSkills agentId="advisor" agentName="Advisor" />); });
    const others = screen.getByRole('heading', { name: 'From files and plugins' }).closest('section')!;
    expect(within(others).getByText('working-in-a-workspace')).toBeInTheDocument();
    expect(within(others).getByText('from developer@0.1.0')).toBeInTheDocument();
    expect(within(others).queryByRole('button')).not.toBeInTheDocument();
  });

  it('removes a learned skill and says what stays', async () => {
    await act(async () => { render(<AgentSkills agentId="advisor" agentName="Advisor" />); });
    vi.mocked(api.agentSkills).mockResolvedValue({ agent: 'advisor', writable: true, skills: [PLUGIN] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove' })); });
    expect(api.removeSkill).toHaveBeenCalledWith('advisor', LEARNED.name);
    expect(await screen.findByText(/Its versions are kept, and Advisor will not propose it again for 90 days/)).toBeInTheDocument();
    expect(screen.queryByText('Check a bank balance in the browser')).not.toBeInTheDocument();
  });
});
