/**
 * `buddi agents` — the parsing and the rendering, which is all of it that is
 * pure. The live turn (`test`) and the file write (`set`) are covered by core's
 * own tests and by the API test next door.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelCatalogue } from '@buddi/core';
import {
  agentLine,
  parseAgentsArgs,
  renderAgentLines,
  renderChange,
  renderModelCatalogue,
  rolesOf,
  setEngine,
  TEST_PROMPT,
  type AgentLine,
} from './agents-cli.js';
import { loadGatewayCatalog, createToolRegistry } from './agents/catalog.js';

describe('parseAgentsArgs', () => {
  it('is a listing when nothing follows the command word', () => {
    expect(parseAgentsArgs([])).toEqual({ action: 'list' });
  });

  it('parses show', () => {
    expect(parseAgentsArgs(['show', 'ledger'])).toEqual({ action: 'show', handle: 'ledger' });
    expect(() => parseAgentsArgs(['show'])).toThrow(/needs an agent handle/);
    expect(() => parseAgentsArgs(['show', 'ledger', 'extra'])).toThrow(/unexpected argument/);
  });

  it('parses every set option', () => {
    expect(
      parseAgentsArgs([
        'set',
        'ledger',
        '--provider',
        'openai',
        '--model',
        'gpt-5',
        '--max-turns',
        '6',
        '--language',
        'fr',
      ]),
    ).toEqual({
      action: 'set',
      handle: 'ledger',
      change: { provider: 'openai', model: 'gpt-5', maxTurns: 6, language: 'fr' },
    });
  });

  it('refuses a set that changes nothing, and values that are not values', () => {
    expect(() => parseAgentsArgs(['set', 'ledger'])).toThrow(/needs something to change/);
    expect(() => parseAgentsArgs(['set', 'ledger', '--provider', 'azure'])).toThrow(
      /unknown provider: azure/,
    );
    expect(() => parseAgentsArgs(['set', 'ledger', '--max-turns', '0'])).toThrow(
      /positive integer/,
    );
    expect(() => parseAgentsArgs(['set', 'ledger', '--language', 'kr'])).toThrow(/mirror, en, fr/);
    expect(() => parseAgentsArgs(['set', 'ledger', '--model'])).toThrow(/needs a model id/);
    expect(() => parseAgentsArgs(['set', 'ledger', '--engine', 'x'])).toThrow(/unknown option/);
  });

  it('parses models, with an optional provider filter', () => {
    expect(parseAgentsArgs(['models'])).toEqual({ action: 'models' });
    expect(parseAgentsArgs(['models', '--provider', 'openai'])).toEqual({
      action: 'models',
      provider: 'openai',
    });
    expect(() => parseAgentsArgs(['models', '--all'])).toThrow(/unknown option/);
  });

  it('parses test, with a default prompt that costs almost nothing', () => {
    expect(parseAgentsArgs(['test', 'ledger'])).toEqual({
      action: 'test',
      handle: 'ledger',
      prompt: TEST_PROMPT,
    });
    expect(parseAgentsArgs(['test', 'ledger', '--prompt', 'hi']).action).toBe('test');
    expect(() => parseAgentsArgs(['test'])).toThrow(/needs an agent handle/);
  });

  it('answers help, and refuses a verb it does not have', () => {
    expect(parseAgentsArgs(['--help'])).toEqual({ action: 'help' });
    expect(() => parseAgentsArgs(['delete', 'ledger'])).toThrow(/unknown agents command/);
  });
});

describe('the listing', () => {
  const line = (over: Partial<AgentLine> = {}): AgentLine => ({
    handle: 'ledger',
    id: 'finance-advisor',
    isDefault: true,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    credential: 'api-key from ANTHROPIC_API_KEY',
    available: true,
    roles: [],
    ...over,
  });

  it('shows handle, id, provider, model, credential and availability', () => {
    const text = renderAgentLines([line()]);
    expect(text).toContain('@ledger');
    expect(text).toContain('finance-advisor');
    expect(text).toContain('anthropic');
    expect(text).toContain('claude-sonnet-5');
    expect(text).toContain('api-key from ANTHROPIC_API_KEY');
    expect(text).toContain('(default)');
    expect(text).toContain('available');
  });

  it('says why an agent cannot run rather than hiding it', () => {
    const text = renderAgentLines([
      line({
        handle: 'scout',
        provider: 'openai',
        model: 'gpt-5',
        available: false,
        unavailableReason: 'environment variable OPENAI_API_KEY is not set',
      }),
    ]);
    expect(text).toContain('unavailable: environment variable OPENAI_API_KEY is not set');
  });

  it('shows roles when another change has given the agent some', () => {
    expect(renderAgentLines([line({ roles: ['money', 'ops'] })])).toContain('roles: money, ops');
  });

  it('says so plainly when nothing is installed', () => {
    expect(renderAgentLines([])).toBe('No agents are installed.');
  });

  it('reads roles defensively, whether or not the key exists yet', () => {
    expect(rolesOf({})).toEqual([]);
    expect(rolesOf({ roles: ['money'] })).toEqual(['money']);
  });
});

describe('the before/after line', () => {
  it('names each key that moved', () => {
    const text = renderChange('ledger', ['model'], { model: 'claude-sonnet-5' }, { model: 'claude-opus-5' });
    expect(text).toBe('@ledger model: claude-sonnet-5 → claude-opus-5');
  });

  it('says nothing was written when nothing moved', () => {
    expect(renderChange('ledger', [], {}, {})).toContain('nothing was written');
  });
});

describe('the model catalogue, rendered', () => {
  it('groups by provider, marks what is usable and names the default', () => {
    const text = renderModelCatalogue(modelCatalogue({ ANTHROPIC_API_KEY: 'sk-test' }));
    expect(text).toContain('anthropic — usable (api-key from ANTHROPIC_API_KEY)');
    expect(text).toContain('default: claude-sonnet-5 (built-in default; override with BUDDI_MODEL)');
    expect(text).toContain('claude-opus-5');
    expect(text).toContain('openai — unusable:');
    expect(text).toContain('gpt-5');
  });
});

describe('agentLine, over a real catalog', () => {
  it('reads an agent directory into a row', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-agents-'));
    mkdirSync(path.join(dir, 'agents', 'demo'), { recursive: true });
    writeFileSync(
      path.join(dir, 'agents', 'demo', 'agent.md'),
      [
        '---',
        'id: demo',
        'handle: demo',
        'name: Demo',
        'description: A demo agent',
        'provider: openai',
        'model: gpt-5',
        'tools: []',
        'default: true',
        '---',
        '',
        'You are a demo.',
        '',
      ].join('\n'),
    );
    const catalog = loadGatewayCatalog({
      dir: path.join(dir, 'agents'),
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      registry: createToolRegistry({}),
    });
    const row = agentLine(catalog.resolve('demo'));
    expect(row).toMatchObject({
      handle: 'demo',
      id: 'demo',
      provider: 'openai',
      model: 'gpt-5',
      credential: 'api-key from OPENAI_API_KEY',
      available: false,
      isDefault: true,
    });
    expect(row.unavailableReason).toContain('OPENAI_API_KEY');
  });
});

describe('buddi agents set', () => {
  const agentFile = (): { handle: string; file: string; source: string } => {
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-set-'));
    const file = path.join(dir, 'agent.md');
    const source = [
      '---',
      'id: demo',
      'handle: demo',
      'name: Demo',
      'description: A demo agent',
      'provider: anthropic',
      'model: claude-sonnet-5',
      'tools: []',
      '---',
      '',
      'You are a demo agent.',
      '',
    ].join('\n');
    writeFileSync(file, source);
    return { handle: 'demo', file, source };
  };

  const io = (): { out: string[]; err: string[]; io: Parameters<typeof setEngine>[2] } => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
  };

  it('quotes the typed problem when the model belongs to the other provider', () => {
    const agent = agentFile();
    const sink = io();
    expect(setEngine(agent, { model: 'gpt-5' }, sink.io)).toBe(1);
    expect(sink.err.join('\n')).toContain(
      'model "gpt-5" is a openai model and provider "anthropic" is pinned',
    );
    expect(sink.err.join('\n')).toContain('a model is never migrated for you');
    // Refused means refused: the file is exactly as it was.
    expect(readFileSync(agent.file, 'utf8')).toBe(agent.source);
    expect(sink.out).toEqual([]);
  });

  it('prints a before/after line and the restart reminder', () => {
    const agent = agentFile();
    const sink = io();
    expect(setEngine(agent, { model: 'claude-opus-5' }, sink.io)).toBe(0);
    const text = sink.out.join('\n');
    expect(text).toContain('@demo model: claude-sonnet-5 → claude-opus-5');
    expect(text).toContain('buddi service restart');
    expect(readFileSync(agent.file, 'utf8')).toContain('model: claude-opus-5');
  });

  it('moves provider and model together', () => {
    const agent = agentFile();
    const sink = io();
    expect(setEngine(agent, { provider: 'openai', model: 'gpt-5' }, sink.io)).toBe(0);
    const after = readFileSync(agent.file, 'utf8');
    expect(after).toContain('provider: openai');
    expect(after).toContain('model: gpt-5');
  });
});
