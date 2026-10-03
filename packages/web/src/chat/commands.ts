/**
 * The composer's `/` menu: the chat's own commands, then the ones installed
 * plugins add (docs/dashboard.md, The composer).
 *
 * The plugins' list rides on the roster the shell already re-reads
 * (`/api/chat/agents`), so the shell hands it here and every composer reads it
 * without a request of its own.
 */
import { useSyncExternalStore } from 'react';
import type { PluginCommandView } from './types';

/** One row of the menu. Required words (`<…>`) make Enter insert the command rather than run it. */
export interface CommandRow {
  group: string;
  name: string;
  args?: string;
  desc: string;
  /** A key that does the same, shown on the right. */
  key?: string;
  /** Shown, but nothing to do now (/stop with nothing running). */
  off?: boolean;
  /** The chat's own, or a plugin's — which is sent to the agent as the owner's words. */
  source: 'chat' | 'plugin';
}

/** The chat's own commands, which the page runs itself. */
export const CHAT_COMMAND_NAMES = ['use', 'new', 'stop', 'quiet'] as const;
export type ChatCommandName = (typeof CHAT_COMMAND_NAMES)[number];

export function isChatCommand(name: string): name is ChatCommandName {
  return (CHAT_COMMAND_NAMES as readonly string[]).includes(name);
}

export function chatCommands(agentName: string, running: boolean): CommandRow[] {
  return [
    { group: 'This chat', name: 'use', args: '<agent>', desc: 'Talk to another agent from here on', source: 'chat' },
    { group: 'This chat', name: 'new', args: '[what it is for]', desc: 'Make a new agent with Agent Father', source: 'chat' },
    { group: 'This chat', name: 'stop', desc: running ? `Stop what ${agentName} is doing` : 'Nothing is running', key: 'Esc', off: !running, source: 'chat' },
    { group: 'This chat', name: 'quiet', args: '[1d|1w|off]', desc: 'No messages from agents for a while', source: 'chat' },
  ];
}

/** A plugin's name as a group heading: `news` → "From News". */
const titleOf = (plugin: string): string => plugin.replace(/^plugin-/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function pluginRows(commands: readonly PluginCommandView[]): CommandRow[] {
  return commands.map((c) => ({
    group: `From ${titleOf(c.plugin)}`,
    name: c.name,
    ...(c.args ? { args: c.args } : {}),
    desc: c.description,
    source: 'plugin' as const,
  }));
}

/** Whether Enter should insert the command for words rather than run it. */
export const needsWords = (row: CommandRow): boolean => Boolean(row.args && row.args.startsWith('<'));

let current: readonly PluginCommandView[] = [];
const listeners = new Set<() => void>();

/** The shell's roster read brought the plugins' commands. Unchanged lists notify nobody. */
export function setPluginCommands(next: readonly PluginCommandView[] | undefined): void {
  const list = next ?? [];
  if (JSON.stringify(list) === JSON.stringify(current)) return;
  current = list;
  listeners.forEach((listener) => listener());
}

export function usePluginCommands(): readonly PluginCommandView[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
    () => current,
  );
}
