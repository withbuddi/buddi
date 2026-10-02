/**
 * The agent catalogue in words: what a card, the detail page and the sheets
 * say about a package, computed from what `/api/catalogue` answers.
 *
 * A package's grant is a list of tool names; the owner reads it family by
 * family ("Mail: reads and searches your mail; writes drafts, you send them").
 * The sentences for buddi's own families and the By-buddi plugins live here;
 * any other family is named and counted, never guessed at.
 */
import { api, type CatalogueAgent, type CatalogueMissing } from '../../api';
import { pluginSettingsRoute, settingsRoute } from '../../routes';

export const CATEGORY_WORDS: Record<string, string> = {
  work: 'Work',
  money: 'Money',
  home: 'Home',
  health: 'Health',
  learning: 'Learning',
  life: 'Life',
};

export const categoryWord = (category: string): string => CATEGORY_WORDS[category] ?? capitalise(category);

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "A", "A and B", "A, B and C". */
export function and(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "1.2.0" reads "1.2"; "1.2.3" stays. */
export function shortVersion(version: string): string {
  return version.replace(/\.0$/, '');
}

/** A package's picture through the gateway, or nothing (its initials are drawn). */
export function avatarUrl(entry: Pick<CatalogueAgent, 'avatar'>): string | undefined {
  return entry.avatar ? api.marketAssetUrl(entry.avatar) : undefined;
}

/** What a requirement that is not a plugin is called, and where it is fixed. */
const NEED_WORDS: Record<string, { title: string; fix: string; route: string }> = {
  mailbox: { title: 'your mailbox', fix: 'Add a mailbox', route: pluginSettingsRoute('email', 'settings') },
  'image-account': { title: 'a drawing account', fix: 'Link an account', route: settingsRoute('accounts') },
};

export function needWords(name: string): { title: string; fix: string; route: string } {
  return NEED_WORDS[name.replace(/\?$/, '')] ?? { title: name, fix: 'Set it up', route: settingsRoute() };
}

/** A plugin by its name when nothing better is known: "calendar" → "Calendar". */
export const pluginTitle = (name: string): string => capitalise(name);

/** How a missing thing is called on a chip: "Finance", "a drawing account". */
export function missingTitle(m: CatalogueMissing): string {
  return m.kind === 'plugin' ? m.title : needWords(m.name).title;
}

/** The one fix for something missing that Add cannot install on the way, as a button and where it goes. */
export function missingFix(m: CatalogueMissing): { label: string; route: string } | null {
  if (m.kind === 'need') {
    const words = needWords(m.name);
    return { label: words.fix, route: words.route };
  }
  if (m.fix === 'enable') return { label: `Turn on ${m.title}`, route: settingsRoute('plugins') };
  if (m.fix === 'update') return { label: `Update ${m.title}`, route: settingsRoute('plugins') };
  if (!m.byBuddi) return { label: `Install ${m.title}`, route: settingsRoute('plugins') };
  return null;
}

/** The plugins and needs a package uses that are here, in muted words; missing ones are the chip's. */
export function usesWords(entry: CatalogueAgent, loaded: ReadonlySet<string>): string[] {
  const missing = new Set((entry.missing ?? []).map((m) => m.name));
  const plugins = [...Object.keys(entry.requires), ...Object.keys(entry.optional)].filter((name) => !missing.has(name) && loaded.has(name));
  return plugins.map(pluginTitle);
}

/** The skill file's name as a title: "writing-the-morning-brief.md" → "Writing the morning brief". */
export function skillTitle(file: string): string {
  return capitalise(file.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim());
}

/* ------------------------------------------------------------------ *
 * What it can reach
 * ------------------------------------------------------------------ */

interface FamilyWords {
  title: string;
  line: (tools: readonly string[]) => string;
}

const has = (tools: readonly string[], name: string): boolean => tools.includes(name);

/** buddi's own families and the By-buddi plugins', in the detail page's words. */
const FAMILIES: Record<string, FamilyWords> = {
  email: {
    title: 'Mail',
    line: (t) => (has(t, 'email.draft') || has(t, 'email.*') ? 'Reads and searches your mail. Writes drafts; you send them.' : 'Searches and reads your mail.'),
  },
  calendar: { title: 'Calendar', line: () => 'Reads your calendars. Never adds or moves an event.' },
  weather: { title: 'Weather', line: () => 'Reads the forecast for your places.' },
  reminder: {
    title: 'Reminders',
    line: (t) => (t.some((x) => x.startsWith('schedule.')) ? 'Sets reminders and runs its own missions.' : 'Sets reminders.'),
  },
  memory: { title: 'Memory', line: () => 'Remembers what you tell it. You can read every note.' },
  owner: { title: 'You', line: () => 'Messages you when something needs you.' },
  web: { title: 'Web', line: () => 'Searches and reads web pages.' },
  artifacts: { title: 'Files', line: () => 'Reads what you share in Files.' },
  finance: { title: 'Finance', line: () => 'Reads your accounts, cards, loans and statements.' },
  image: { title: 'Image', line: () => 'Makes pictures with your drawing account.' },
  speech: { title: 'Speech', line: () => 'Says words out loud.' },
  goal: { title: 'Goals', line: () => 'Keeps your goals and progress.' },
  canvas: { title: 'Canvas', line: () => 'Draws on the canvas beside your chat.' },
};

/** Families that read as one row: missions are reminders on a timer, the browser is the web. */
const SAME_ROW: Record<string, string> = { schedule: 'reminder', browser: 'web' };

/**
 * The grant, family by family, in words: `[title, line]` rows in the order the
 * package lists them. `tiers` (tool → tier) adds "asks you first" when a
 * family holds a gated tool.
 */
export function reachRows(tools: readonly string[], tiers: ReadonlyMap<string, string> = new Map()): Array<[string, string]> {
  const order: string[] = [];
  const byFamily = new Map<string, string[]>();
  for (const raw of tools) {
    const tool = raw.replace(/\?$/, '');
    const family = tool.split('.')[0] ?? tool;
    const key = SAME_ROW[family] ?? family;
    if (!byFamily.has(key)) {
      byFamily.set(key, []);
      order.push(key);
    }
    byFamily.get(key)!.push(tool);
  }
  return order.map((key) => {
    const list = byFamily.get(key)!;
    const words = FAMILIES[key];
    const gated = list.some((t) => tiers.get(t) === 'gated');
    const line = words ? words.line(list) : `${list.length === 1 ? 'One of its tools' : `${list.length} of its tools`}.`;
    return [words?.title ?? capitalise(key), gated && !/asks you/i.test(line) ? `${line} Asks you first before it changes anything.` : line];
  });
}

/** The reach in one line, for the install sheet: "Reaches Mail, Calendar and Memory." */
export function reachLine(rows: ReadonlyArray<[string, string]>): string {
  return rows.length === 0 ? 'Nothing beyond its own chat.' : `Reaches ${and(rows.map(([title]) => title))}.`;
}

/** Tool → tier, from the package's claims or a plan's rows. */
export function tierMap(rows: ReadonlyArray<{ name: string; tier?: string }> | undefined): Map<string, string> {
  return new Map((rows ?? []).filter((r) => r.tier).map((r) => [r.name, r.tier as string]));
}
