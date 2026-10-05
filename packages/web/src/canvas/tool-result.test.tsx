import { fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { Canvas } from './Canvas';
import { inspectToolCall, renderablesFrom } from './renderables';
import { fieldKind, resultViewFor } from './result-shape';
import { ToolResult } from './views/ToolResult';
import { OWN_TOOL_TITLES, QUIET_TOOLS } from '../chat/own-tools';
import type { ChatMessage } from '../chat/types';

/** Three shapes a tool with no view of its own hands back. */
const PROFILE = {
  preferredName: 'Amen',
  timezone: 'Europe/Ljubljana',
  language: 'en',
  onboarding: 'done',
  stepsDone: ['name', 'timezone', 'language'],
  detectedTimezone: 'Europe/Ljubljana',
  updatedAt: '2026-10-01T09:30:00Z',
};
const ITEMS = {
  agents: [
    { id: 'a1', name: 'Scout', role: 'research', model: 'claude-sonnet-5' },
    { id: 'a2', name: 'Ledger', role: 'finance', model: 'claude-sonnet-5' },
    { id: 'a3', name: 'Quill', role: 'writing', model: 'gpt-5' },
  ],
  total: 3,
};
const SETTINGS = { notifications: true, quietHours: false, theme: 'dark', digest: 'weekly', maxTabs: 5 };
const NESTED = {
  status: 'active',
  started: '2026-09-20',
  tags: ['home', 'q4'],
  history: Array.from({ length: 12 }, (_, i) => `step ${i + 1}`),
  limits: { daily: 20, monthly: 400 },
};

function call(id: string, name: string, output: unknown, ok = true): ChatMessage[] {
  return [
    { id: `u-${id}`, role: 'assistant', at: '', blocks: [{ type: 'tool_use', id, name, input: {} }] },
    { id: `r-${id}`, role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: id, name, ok, output, ...(ok ? {} : { error: 'It broke.' }) }] },
  ];
}

describe('the result registry, keyed by shape', () => {
  it('picks a purpose-built view per shape and a grid for the rest', () => {
    expect(resultViewFor(PROFILE)).toBe('profile');
    expect(resultViewFor(ITEMS)).toBe('items');
    expect(resultViewFor(SETTINGS)).toBe('settings');
    expect(resultViewFor(NESTED)).toBe('fields');
    expect(resultViewFor([1, 2, 3])).toBe('other');
    // Rows that are links stay with the structured records view.
    expect(resultViewFor([{ title: 'A', url: 'https://a.example' }])).toBe('other');
  });

  it('reads each field for how it should look', () => {
    expect(fieldKind('enabled', true).kind).toBe('boolean');
    expect(fieldKind('status', 'in_progress').kind).toBe('enum');
    expect(fieldKind('name', 'scout').kind).toBe('text');
    expect(fieldKind('model', 'claude-sonnet-5').kind).toBe('text');
    expect(fieldKind('day', '2026-09-20').kind).toBe('day');
    expect(fieldKind('at', '2026-09-20T10:00:00Z').kind).toBe('moment');
    expect(fieldKind('tags', ['a', 'b']).kind).toBe('chips');
    expect(fieldKind('tags', Array.from({ length: 9 }, () => 'x')).kind).toBe('rows');
    expect(fieldKind('limits', { a: 1 }).kind).toBe('group');
  });
});

describe('the generic tool-result card', () => {
  it('draws a profile with its name first and the rest as a definition grid', () => {
    render(<ToolResult value={PROFILE} title="Your profile" tool="owner.get_profile" face={<span data-testid="face" />} timezone="UTC" />);
    const card = screen.getByTestId('tool-result');
    expect(card).toHaveAttribute('data-view', 'profile');
    expect(screen.getByRole('heading', { name: 'Your profile' })).toBeInTheDocument();
    expect(screen.getByTestId('face')).toBeInTheDocument();
    expect(screen.getByText('Amen')).toHaveClass('wb-result-lead-v');
    expect(screen.getByText('Preferred name')).toHaveClass('wb-result-lead-k');
    // Steps done are chips; the onboarding state is a badge.
    expect(screen.getByText('timezone', { selector: '.ui-pill' })).toBeInTheDocument();
    expect(screen.getByText('done', { selector: '.ui-pill' })).toBeInTheDocument();
    // A moment is the owner's way, not ISO.
    expect(screen.queryByText('2026-10-01T09:30:00Z')).toBeNull();
    expect(card.querySelector('time')).toHaveAttribute('dateTime', '2026-10-01T09:30:00Z');
  });

  it('draws a list of items as a name and a fact or two each', () => {
    render(<ToolResult value={ITEMS} title="Your team" tool="platform.list_agents" timezone="UTC" />);
    expect(screen.getByTestId('tool-result')).toHaveAttribute('data-view', 'items');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Scout')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('research')).toBeInTheDocument();
    // The id is not one of the facts.
    expect(screen.queryByText('a1')).toBeNull();
    expect(screen.getByText('Agents')).toBeInTheDocument();
  });

  it('draws settings as rows with booleans and states as badges', () => {
    render(<ToolResult value={SETTINGS} title="Settings" tool="x.settings" timezone="UTC" />);
    expect(screen.getByTestId('tool-result')).toHaveAttribute('data-view', 'settings');
    expect(screen.getByText('Yes').closest('.ui-pill')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByText('No').closest('.ui-pill')).not.toHaveAttribute('data-tone');
    expect(screen.getByText('dark', { selector: '.ui-pill' })).toBeInTheDocument();
    expect(screen.getByText('Quiet hours')).toBeInTheDocument();
  });

  it('folds nested objects, keeps long lists compact, and hides the raw JSON under ⋯', () => {
    render(<ToolResult value={NESTED} title="Plan" tool="x.plan" timezone="UTC" />);
    expect(screen.getByText('Limits').closest('details')).toBeInTheDocument();
    expect(screen.getByText('step 8')).toBeInTheDocument();
    expect(screen.queryByText('step 9')).toBeNull();
    expect(screen.getByRole('button', { name: '4 more' })).toBeInTheDocument();
    expect(screen.queryByText(/"status": "active"/)).toBeNull();
    const more = screen.getByRole('button', { name: 'More for Plan' });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Raw JSON' }));
    expect(screen.getByText(/"status": "active"/)).toBeInTheDocument();
  });

  it('is what the Canvas draws for a result with no view of its own', () => {
    const tabs = renderablesFrom({ messages: call('s1', 'x.plan', NESTED), descriptors: [] });
    expect(tabs).toHaveLength(1);
    render(<Canvas renderables={tabs} activeId={null} onActivate={() => {}} timezone="UTC" maxTabs={5} cardFace={<span data-testid="small-face" />} />);
    expect(screen.getByTestId('tool-result')).toBeInTheDocument();
    expect(screen.getByTestId('small-face')).toBeInTheDocument();
  });
});

describe('quiet tools', () => {
  it('opens no tab for what an agent reads to know its owner', () => {
    const messages = [...call('p1', 'owner.get_profile', PROFILE), ...call('m1', 'memory.recall', { notes: [{ name: 'Coffee', detail: 'oat' }] })];
    expect(renderablesFrom({ messages, descriptors: [], quiet: QUIET_TOOLS, titles: OWN_TOOL_TITLES })).toEqual([]);
    // Without the rule it would have opened tabs: the rule is what holds them back.
    expect(renderablesFrom({ messages, descriptors: [] }).length).toBeGreaterThan(0);
  });

  it('keeps quiet to reads: a write keeps its Canvas tab', () => {
    for (const write of ['owner.set_profile', 'owner.rename_me', 'owner.finish_onboarding', 'memory.note', 'memory.remember_preference']) {
      expect(QUIET_TOOLS.has(write)).toBe(false);
      const tabs = renderablesFrom({ messages: call('w1', write, PROFILE), descriptors: [], quiet: QUIET_TOOLS, titles: OWN_TOOL_TITLES });
      expect(tabs).toHaveLength(1);
    }
    for (const read of ['owner.get_profile', 'memory.recall', 'memory.get_preferences', 'memory.people', 'memory.person', 'platform.list_agents', 'system.time']) {
      expect(QUIET_TOOLS.has(read)).toBe(true);
    }
  });

  it('still keeps the tab of a quiet tool that failed', () => {
    const tabs = renderablesFrom({ messages: call('p1', 'owner.get_profile', null, false), descriptors: [], quiet: QUIET_TOOLS, titles: OWN_TOOL_TITLES });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ title: 'Your profile', tone: 'critical' });
  });

  it('shows its result, not its arguments, when the owner opens the step row', () => {
    const inspected = inspectToolCall(call('p1', 'owner.get_profile', PROFILE), 'p1', { resultOf: QUIET_TOOLS, titles: OWN_TOOL_TITLES });
    expect(inspected).toMatchObject({ title: 'Your profile', renderer: 'structured', props: { value: PROFILE } });
  });
});
