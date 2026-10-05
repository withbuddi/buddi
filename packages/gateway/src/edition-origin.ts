/**
 * Where a story the owner asks about came from.
 *
 * "Tell me more about <headline> in the news today": the headline is a line
 * of an edition an agent delivered this morning, and the agent asked has no
 * idea. It answered from memory, with invented citations. This finds the
 * edition, and the context line it adds names the story, the agent and
 * plugin it came from, and how to read it — the tool when the agent holds
 * one, else the colleague to delegate to.
 *
 * The edition is read from core's own record, not the plugin's tables: a
 * delivered edition is a `mission.report` whose link names a saved edition
 * (`#/p/<plugin>/…?edition=…`, the same rule the chat uses to draw the
 * edition card), in a run that left a `mission.delivered` event today. One
 * query, on the event index, bounded to the last day and a handful of rows.
 */
import { DELEGATE_TOOL_NAME, localDateString, type CoreToolContext } from '@buddi/core';

/** Lower-case, accents gone, punctuation as space, single spaces. */
export function normaliseWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
}

/** The longest run of words two sequences share, in order and contiguous. */
function longestCommonRun(a: readonly string[], b: readonly string[]): number {
  let best = 0;
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (row[j]! > best) best = row[j]!;
      diag = up;
    }
  }
  return best;
}

/** How many of the headline's words appear in the message, in order (a subsequence). */
function inOrder(headline: readonly string[], message: readonly string[]): number {
  let found = 0;
  let at = 0;
  for (const word of headline) {
    const next = message.indexOf(word, at);
    if (next === -1) continue;
    found++;
    at = next + 1;
  }
  return found;
}

/**
 * Does the owner's message name this headline? Normalised, case and accents
 * ignored; at least 70% of the headline's words appear in the message in
 * order, or a long run of it (five words, or the whole of a shorter one)
 * appears word for word. Headlines under three words never match: "Brazil
 * votes" is a topic, not a story.
 */
export function namesHeadline(message: string, headline: string): boolean {
  const h = normaliseWords(headline);
  if (h.length < 3) return false;
  const m = normaliseWords(message);
  if (m.length === 0) return false;
  if (inOrder(h, m) / h.length >= 0.7) return true;
  return longestCommonRun(h, m) >= Math.min(5, h.length);
}

/**
 * The headline lines of an edition's text. An edition is light text: a
 * masthead, section names in capitals, then per story a headline, a line or
 * two of summary and a source line with its link. A headline is a short
 * line with no link, not all capitals, not ending in a full stop.
 */
export function editionHeadlines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s#>*_-]+|[\s*_]+$/g, '').replace(/^(?:UPDATE|NEW|MISE À JOUR)\s*[·:-]\s*/i, '').trim();
    if (line === '' || /https?:\/\//.test(line) || /[.!?…:]$/.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length < 3 || words.length > 22) continue;
    if (line === line.toUpperCase()) continue;
    if (line.startsWith('—')) continue;
    out.push(line);
  }
  return out;
}

export interface EditionOrigin {
  headline: string;
  /** The agent that delivered the edition. */
  agentId: string;
  /** The plugin its link names ("news"). */
  plugin: string;
}

/**
 * The story of today's edition this message names, if any. Nothing when no
 * edition was delivered today, which is the one query's whole cost.
 */
export async function findEditionOrigin(
  ctx: Pick<CoreToolContext, 'db' | 'now' | 'timezone'>,
  message: string,
): Promise<EditionOrigin | null> {
  if (normaliseWords(message).length < 3) return null;
  const now = ctx.now();
  const { rows } = await ctx.db.query(
    `with delivered as (
       select distinct conversation_id from core.events
        where kind = 'mission.delivered' and created_at >= $1 and conversation_id is not null
     )
     select c.agent_id, m.created_at, b->'input'->>'text' as text, b->'input'->>'link' as link
       from delivered d
       join core.conversations c on c.id = d.conversation_id
       join core.messages m on m.conversation_id = d.conversation_id and m.role = 'assistant'
       cross join lateral jsonb_array_elements(case when jsonb_typeof(m.content) = 'array' then m.content else '[]'::jsonb end) b
      where b->>'type' = 'tool_use' and b->>'name' = 'mission.report'
        and b->'input'->>'link' ~ '^#/p/[a-z0-9_-]+/.*[?&]edition='
      order by m.created_at desc
      limit 6`,
    [new Date(now.getTime() - 36 * 3_600_000)],
  );
  const today = localDateString(now, ctx.timezone);
  for (const row of rows as Array<{ agent_id: string; created_at: Date | string; text: string | null; link: string | null }>) {
    if (!row.text || !row.link) continue;
    if (localDateString(new Date(row.created_at), ctx.timezone) !== today) continue;
    const plugin = /^#\/p\/([a-z0-9_-]+)\//.exec(row.link)?.[1];
    if (!plugin) continue;
    const headline = editionHeadlines(row.text).find((line) => namesHeadline(message, line));
    if (headline) return { headline, agentId: String(row.agent_id), plugin };
  }
  return null;
}

/**
 * The one context line: the story, where it came from, how to read it. The
 * way to read it is worded for this agent's grant: its own tool of that
 * plugin when it holds one, a delegation when it can delegate, else the
 * colleague to name.
 */
export function editionOriginLine(
  origin: EditionOrigin,
  run: { agentId: string; tools: readonly string[] },
  handleOf: (agentId: string) => string | null = () => null,
): string {
  const plugin = origin.plugin.charAt(0).toUpperCase() + origin.plugin.slice(1);
  const handle = handleOf(origin.agentId) ?? origin.agentId;
  const own = run.tools.filter((t) => t.startsWith(`${origin.plugin}.`));
  const search = own.find((t) => t.endsWith('.search')) ?? own[0];
  const read = run.agentId === origin.agentId || search
    ? `read it with ${search ?? 'your own tools'}`
    : run.tools.includes(DELEGATE_TOOL_NAME)
      ? `delegate it to @${handle} (${DELEGATE_TOOL_NAME}, agent "${origin.agentId}")`
      : `say @${handle} has it`;
  return `This message names "${origin.headline}", a story from today's edition by @${handle} (${plugin}): ${read} before you say anything about it.`;
}
