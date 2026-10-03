/**
 * The gateway's half of the composer: the plugins' `/` commands, and what a
 * run is told when the owner names a teammate or runs one.
 */
import { describe, expect, it } from 'vitest';
import type { CatalogAgent, PluginManifest } from '@buddi/core';
import { composerTurnNote, mentionedAgents, pluginCommands, validCommands } from './composer.js';

const agent = (id: string, tools: string[] = [], roles: string[] = []): CatalogAgent => ({ id, handle: id, name: id[0]!.toUpperCase() + id.slice(1), tools, roles } as unknown as CatalogAgent);
const AGENTS = [agent('postie', ['email.read']), agent('lead', ['agent.delegate']), agent('ledger'), agent('father', [], ['maker'])];
const catalog = { byHandle: (h: string) => AGENTS.find((a) => a.handle === h) };
const manifest = (name: string, commands: unknown): PluginManifest => ({ name, version: '1', schema: name, migrationsDir: '', tools: [], commands } as unknown as PluginManifest);

describe('plugin commands', () => {
  it('keeps well-formed commands and drops the malformed, the duplicated and the chat’s own names', () => {
    expect(validCommands([
      { name: '/Edition', description: 'Today’s edition, now' },
      { name: 'read', description: 'Read the last reply aloud', args: '[voice]' },
      { name: 'stop', description: 'clashes' },
      { name: 'Bad Name', description: 'x' },
      { name: 'read', description: 'again' },
      { name: 'empty', description: ' ' },
      { name: 'long', description: 'x'.repeat(121) },
    ] as never)).toEqual([
      { name: 'edition', description: 'Today’s edition, now' },
      { name: 'read', description: 'Read the last reply aloud', args: '[voice]' },
    ]);
    expect(validCommands(undefined)).toEqual([]);
  });

  it('lists every plugin’s commands, the first to claim a name keeping it', () => {
    const registry = { manifests: () => [manifest('news', [{ name: 'edition', description: 'Today’s edition' }]), manifest('speech', [{ name: 'edition', description: 'no' }, { name: 'read', description: 'Read aloud' }]), manifest('finance', undefined)] };
    expect(pluginCommands(registry)).toEqual([
      { plugin: 'news', name: 'edition', description: 'Today’s edition' },
      { plugin: 'speech', name: 'read', description: 'Read aloud' },
    ]);
  });
});

describe('what a turn is told', () => {
  it('names nobody for a plain message', () => {
    expect(composerTurnNote({ agent: AGENTS[0]!, text: 'What needs a reply today?', catalog })).toBeUndefined();
  });

  it('finds the colleagues a message names, not the agent itself, an address, or a handle in code', () => {
    expect(mentionedAgents('@ledger and @postie, mail ana@ledger.com, `@father`', catalog, 'postie').map((a) => a.id)).toEqual(['ledger']);
  });

  it('tells an agent that can delegate to ask the colleague and relay', () => {
    const note = composerTurnNote({ agent: AGENTS[1]!, text: 'check with @ledger first', catalog })!;
    expect(note).toContain('@ledger (Ledger)');
    expect(note).toContain('ask that colleague with agent.delegate');
  });

  it('tells an agent that cannot delegate to say so and offer /use', () => {
    const note = composerTurnNote({ agent: AGENTS[0]!, text: 'ask @father about it', catalog })!;
    expect(note).toContain('you do not hold agent.delegate');
    expect(note).toContain('/use @father');
    expect(note).toContain('who makes and changes agents');
  });

  it('tells the agent which plugin a leading command is from and what it is for', () => {
    const note = composerTurnNote({ agent: AGENTS[0]!, text: '/edition sport only', catalog, commands: [{ plugin: 'news', name: 'edition', description: 'Today’s edition, now' }] })!;
    expect(note).toContain('The owner ran /edition, a command from the news plugin: Today’s edition, now.');
    expect(composerTurnNote({ agent: AGENTS[0]!, text: '/unknown', catalog, commands: [] })).toBeUndefined();
  });
});
