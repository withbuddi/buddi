/**
 * The command table, walked against the parser: every command the parser
 * takes has a row, every row parses, and the help drawn from it says what the
 * table says.
 */
import {
  parseAgentsArgs,
  parseChatArgs,
  parseMissionsArgs,
  parseAccountsArgs,
  parseNudgesArgs,
  parsePluginsArgs,
  parseRemindersArgs,
} from '@buddi/gateway';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_ACTIONS,
  DB_ACTIONS,
  parseArgs,
  SERVICE_ACTIONS,
  TELEGRAM_ACTIONS,
  VAULT_ACTIONS,
  type Command,
} from './args.js';
import {
  anchorOf,
  COMMANDS,
  editDistance,
  entryFor,
  GROUPS,
  installKind,
  jsonFromEnv,
  nearestCommand,
  renderCommandHelp,
  renderHelp,
  renderReference,
  shortUsage,
} from './commands.js';

/**
 * Parse the way `main` does: this binary's words, then the delegate's, with
 * `--json` taken off for this parser and put back for the delegate.
 */
function parseFully(argv: string[], json = false): Command {
  const command = parseArgs(argv);
  const delegated = 'argv' in command ? (json ? [...command.argv, '--json'] : command.argv) : [];
  if (command.kind === 'chat-cli') {
    if (delegated[0] === 'agents') parseAgentsArgs(delegated.slice(1));
    else parseChatArgs(delegated);
  } else if (command.kind === 'missions') parseMissionsArgs(delegated);
  else if (command.kind === 'accounts') parseAccountsArgs(delegated);
  else if (command.kind === 'plugins') parsePluginsArgs(delegated);
  else if (command.kind === 'reminders') parseRemindersArgs(delegated);
  else if (command.kind === 'nudges') parseNudgesArgs(delegated);
  return command;
}

/** A shell line as argv, quotes respected: `ask "what now?"` is two words. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2]) as string);
}

/** The short usage with its placeholders filled in. */
function sample(usage: string): string[] {
  return words(usage)
    .slice(1)
    .map((w) => (w.startsWith('<') ? w.replace(/[<>]/g, '') || 'x' : w));
}

/**
 * Every command the parser (and the parsers it delegates to) accepts, as the
 * words that name it. Built from the parser's own action lists where it has
 * them, so a new action there fails this test until it has a row.
 */
const PARSED: string[][] = [
  [],
  ['status'],
  ['doctor'],
  ['version'],
  ['upgrade'],
  ['uninstall'],
  ['init'],
  ['migrate'],
  ['serve'],
  ['mcp'],
  ['pause'],
  ['resume'],
  ['dashboard'],
  ['chat'],
  ['ask', 'q'],
  ['browser'],
  ['browser', 'install'],
  ['speech'],
  ['speech', 'install'],
  ['jobs'],
  ['jobs', 'retry', 'x'],
  ['jobs', 'cancel', 'x'],
  ...SERVICE_ACTIONS.map((a) => ['service', a]),
  ...DB_ACTIONS.map((a) => ['db', a]),
  ...VAULT_ACTIONS.map((a) => (a === 'list' || a === 'import-env' ? ['vault', a] : ['vault', a, 'NAME'])),
  ...TELEGRAM_ACTIONS.map((a) => (a === 'unpair' ? ['telegram', a, 'x'] : ['telegram', a])),
  ...BACKUP_ACTIONS.map((a) => (a === 'verify' || a === 'restore' ? ['backup', a, 'a.tar.gz'] : ['backup', a])),
  ['agents'],
  ...['show', 'test'].map((a) => ['agents', a, 'ledger']),
  ['agents', 'set', 'ledger', '--max-turns', '5'],
  ['agents', 'models'],
  ['agents', 'migrate'],
  ...['list', 'add-defaults', 'add-recap', 'add-friday-recap'].map((a) => ['missions', a]),
  ...['run-now', 'enable', 'disable'].map((a) => ['missions', a, 'x']),
  ['reminders'],
  ['reminders', 'cancel', 'x'],
  ...['status', 'stop', 'resume'].map((a) => ['nudges', a]),
  ...['list', 'staged'].map((a) => ['plugins', a]),
  ['connections', 'list'],
  ['connections', 'add', 'github'],
  ['connections', 'review', 'github'],
  ['connections', 'give', 'github', '--to', 'buddi'],
  ['connections', 'remove', 'github'],
  ...['info', 'init', 'dev', 'install', 'update', 'approve', 'reject', 'disable', 'enable', 'uninstall'].map((a) => ['plugins', a, 'x']),
];

describe('the command table', () => {
  it('has a row for every command the parser takes', () => {
    const missing = PARSED.filter((argv) => {
      parseFully(argv);
      const entry = entryFor(argv);
      // The row must name the command itself, not only the group above it.
      const named = argv.filter((w) => /^[a-z][a-z-]*$/.test(w)).slice(0, 2).join(' ');
      return entry === undefined || (entry.name !== named && !named.startsWith(`${entry.name} `) && entry.name !== '');
    });
    expect(missing.map((a) => a.join(' '))).toEqual([]);
  });

  it('has rows that all parse, examples included', () => {
    for (const entry of COMMANDS) {
      // The short form, or the example where the short form alone is not enough.
      const line = entry.example?.startsWith('buddi') ? words(entry.example).slice(1) : sample(shortUsage(entry));
      expect(() => parseFully(line), entry.name).not.toThrow();
      if (entry.example?.startsWith('buddi ')) {
        expect(() => parseFully(words(entry.example as string).slice(1)), entry.example).not.toThrow();
      }
      if (entry.example !== undefined && entry.example.startsWith('buddi')) {
        expect(entryFor(words(entry.example).slice(1)), entry.example).toBe(entry);
      }
    }
  });

  it('says every summary as a sentence, and every flag too', () => {
    for (const entry of COMMANDS) {
      expect(entry.summary, entry.name).toMatch(/^[A-Z].*\.$/);
      for (const flag of entry.flags) expect(flag.meaning, `${entry.name} ${flag.flag}`).toMatch(/\.$/);
      expect(entry.usage.startsWith('buddi'), entry.name).toBe(true);
      if (entry.next !== undefined) expect(entry.next, `${entry.name} next`).toMatch(/^[A-Z`].*\.$/);
      for (const code of entry.exitCodes ?? []) expect(code.meaning, `${entry.name} exit ${code.code}`).toMatch(/^([A-Z-]|buddi ).*\.$/);
    }
  });

  it('gives every command an example', () => {
    expect(COMMANDS.filter((e) => e.example === undefined).map((e) => e.name)).toEqual([]);
  });

  it('uses the five groups, in order', () => {
    expect(GROUPS).toEqual(['Everyday', 'Agents', 'Reach', 'Operate', 'Develop']);
    const order = COMMANDS.map((e) => GROUPS.indexOf(e.group));
    expect(order.every((g) => g >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('has each name once', () => {
    const names = COMMANDS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('says what to do instead for every command it hides', () => {
    for (const entry of COMMANDS.filter((e) => e.applies !== 'both')) {
      expect(entry.elsewhere, entry.name).toMatch(/^buddi .* is for a source checkout\. .*\.$/);
    }
    expect(COMMANDS.filter((e) => e.group === 'Develop').every((e) => e.applies === 'checkout')).toBe(true);
  });

  it('offers --json exactly on the reads', () => {
    // The service verbs answer with the state after them, which the release smoke reads.
    const reads = COMMANDS.filter((e) => e.json !== undefined && !e.name.startsWith('service ')).map((e) => e.name);
    expect(reads).toEqual([
      'status',
      'ask',
      'agents',
      'agents show',
      'accounts',
      'accounts show',
      'agents models',
      'missions list',
      'reminders',
      'plugins list',
      'plugins describe',
      'connections list',
      'connections review',
      'telegram devices',
      'backup list',
      'jobs',
      'api-token list',
    ]);
    const service = COMMANDS.filter((e) => e.json !== undefined && e.name.startsWith('service ')).map((e) => e.name);
    expect(service).toEqual(['service status', 'service start', 'service stop', 'service restart']);
    for (const name of [...reads, 'service status']) {
      const entry = COMMANDS.find((e) => e.name === name);
      expect(entry?.flags.some((f) => f.flag === '--json'), name).toBe(true);
      expect(() => parseFully(entry!.example?.startsWith('buddi') ? words(entry!.example).slice(1) : sample(shortUsage(entry!)), true), name).not.toThrow();
    }
  });
});

describe('installKind', () => {
  it('is packaged when the launcher set the install root, a checkout otherwise', () => {
    expect(installKind({ BUDDI_INSTALL_ROOT: '/opt/buddi' })).toBe('packaged');
    expect(installKind({})).toBe('checkout');
    expect(installKind({ BUDDI_INSTALL_ROOT: '  ' })).toBe('checkout');
  });

  it('reads BUDDI_JSON as a yes or a no', () => {
    expect(jsonFromEnv({ BUDDI_JSON: '1' })).toBe(true);
    expect(jsonFromEnv({ BUDDI_JSON: '0' })).toBe(false);
    expect(jsonFromEnv({})).toBe(false);
  });
});

describe('renderHelp', () => {
  it('lists the Develop group in a checkout and hides it in a packaged install', () => {
    const checkout = renderHelp(COMMANDS, 'checkout');
    const packaged = renderHelp(COMMANDS, 'packaged');
    expect(checkout).toContain('buddi init');
    expect(checkout).toContain('Develop');
    expect(packaged).not.toContain('buddi init');
    expect(packaged).not.toContain('Develop');
    expect(packaged).not.toContain('buddi service install');
    expect(packaged).toContain('buddi backup create');
  });

  it('prints one line per command, the groups in order', () => {
    const text = renderHelp(COMMANDS, 'checkout');
    const shown = text.split('\n').filter((l) => l.startsWith('  buddi'));
    expect(shown).toHaveLength(COMMANDS.length);
    const at = GROUPS.map((g) => text.indexOf(`\n${g}\n`));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});

describe('renderCommandHelp', () => {
  it('says what it does, its usage, flags, an example and exit codes', () => {
    const entry = COMMANDS.find((e) => e.name === 'backup create')!;
    const text = renderCommandHelp(entry);
    for (const part of ['Usage', 'Flags', '--encrypt', 'Example', 'Exit codes', '  3  ']) expect(text).toContain(part);
  });

  it('says what it tells you to do next', () => {
    const text = renderCommandHelp(COMMANDS.find((e) => e.name === 'plugins approve')!);
    expect(text).toContain('Then');
    expect(text).toContain('buddi service restart');
  });

  it('documents the JSON fields of a read', () => {
    expect(renderCommandHelp(COMMANDS.find((e) => e.name === 'ask')!)).toContain('conversationId');
  });

  it('says where a hidden command went', () => {
    const init = COMMANDS.find((e) => e.name === 'init')!;
    expect(renderCommandHelp(init, COMMANDS, 'packaged')).toContain(
      'A packaged install sets itself up the first time you run buddi.',
    );
  });
});

describe('nearestCommand', () => {
  it('finds the command a typo meant', () => {
    expect(nearestCommand(['stauts'], 'checkout')).toBe('status');
    expect(nearestCommand(['backup', 'craete'], 'checkout')).toBe('backup create');
    expect(nearestCommand(['agents', 'shwo', 'ledger'], 'checkout')).toBe('agents show');
    expect(nearestCommand(['chta'], 'checkout')).toBe('chat');
  });

  it('says nothing when nothing is close', () => {
    expect(nearestCommand(['xylophone'], 'checkout')).toBeUndefined();
  });

  it('never suggests a command hidden here', () => {
    expect(nearestCommand(['int'], 'packaged')).not.toBe('init');
  });

  it('counts a swap of neighbours as one edit', () => {
    expect(editDistance('stauts', 'status')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

/** The anchors GitHub gives a page's headings: lowercase, punctuation dropped, spaces to hyphens. */
function headingAnchors(page: string): string[] {
  return [...page.matchAll(/^#{1,6} (.+)$/gm)].map((m) =>
    (m[1] as string).toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-'),
  );
}

describe('renderReference', () => {
  const page = renderReference(COMMANDS);

  it('gives every command one section, under its group, with its usage, example and exit codes', () => {
    for (const group of GROUPS) expect(page).toContain(`## ${group}`);
    for (const entry of COMMANDS) {
      const heading = `### ${['buddi', entry.name].filter((w) => w !== '').join(' ')}\n`;
      expect(page.split(heading).length - 1, entry.name).toBe(1);
      const section = page.slice(page.indexOf(heading)).split(/\n#{2,3} /)[0] as string;
      expect(section, entry.name).toContain(`\`\`\`sh\n${entry.usage}\n\`\`\``);
      if (entry.example !== entry.usage) expect(section, entry.name).toContain(`${entry.example}\n`);
      if (entry.next) expect(section, entry.name).toContain(`**Then**: ${entry.next}`);
      for (const flag of entry.flags) expect(section, `${entry.name} ${flag.flag}`).toContain(`- \`${flag.flag}\`: ${flag.meaning}`);
      expect(section, entry.name).toContain('**Exit codes**');
    }
  });

  it('links each command from its group list, and every link lands on a heading', () => {
    const anchors = headingAnchors(page);
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const entry of COMMANDS) expect(anchors, entry.name).toContain(anchorOf(entry));
    const links = [...page.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] as string);
    expect(links.length).toBeGreaterThan(COMMANDS.length);
    expect(links.filter((target) => !anchors.includes(target))).toEqual([]);
  });

  it('opens with the common tasks, each linking to its commands', () => {
    const tasks = page.slice(page.indexOf('## Common tasks'), page.indexOf('## What it is for'));
    for (const title of [
      'Add a model account',
      "Change an agent's model or step budget",
      'Back up and restore',
      'Pair Telegram',
      'Add a local connection',
      'Upgrade',
    ]) {
      expect(tasks).toContain(`### ${title}\n`);
    }
    for (const name of ['agents set', 'agents test', 'agents models', 'backup create', 'backup restore', 'telegram pair', 'connections add', 'upgrade']) {
      expect(tasks, name).toContain(`(#${anchorOf(COMMANDS.find((e) => e.name === name)!)})`);
    }
    expect(page.indexOf('## Common tasks')).toBeLessThan(page.indexOf('## Everyday'));
  });

  it('parses every command line the common tasks print', () => {
    const tasks = page.slice(page.indexOf('## Common tasks'), page.indexOf('## What it is for'));
    const lines = [...tasks.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => (m[1] as string).trim().split('\n'));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      // `<id>` and `<archive>` stand for what the owner has; fill them in to parse.
      const argv = words(line.replace(/<([a-z]+)>/g, '$1')).slice(1);
      expect(() => parseFully(argv), line).not.toThrow();
      expect(entryFor(argv), line).toBeDefined();
    }
  });
});
