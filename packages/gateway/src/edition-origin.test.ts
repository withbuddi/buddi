import { describe, expect, it, vi } from 'vitest';
import type { CoreToolContext } from '@buddi/core';
import { editionHeadlines, editionOriginLine, findEditionOrigin, namesHeadline } from './edition-origin.js';
import { systemContext } from './system-context.js';

const EDITION = `Morning edition · Mon 5 Oct
Six stories. Brazil votes tomorrow; North Korea fired a ballistic missile overnight.

INTERNATIONAL
UPDATE · Brazil heads into Sunday's election
Le Figaro (fr) describes a rematch-flavoured race.
Le Figaro (fr) and 4 more · https://www.lefigaro.fr/international/x

Spain's parliament rejects two housing bills
France 24 says lawmakers voted down two affordable housing bills.
France 24 and 2 more · https://www.france24.com/en/europe/x

North Korea fires a ballistic missile toward the sea
South Korea's military says it flew more than 700 km, Al Jazeera reports.
Al Jazeera and 3 more · https://www.aljazeera.com/news/x

— Anchor · next at 12:30`;

describe('edition headlines', () => {
  it('takes the headline lines and leaves the masthead, sections, summaries and source lines', () => {
    expect(editionHeadlines(EDITION)).toEqual([
      'Morning edition · Mon 5 Oct',
      "Brazil heads into Sunday's election",
      "Spain's parliament rejects two housing bills",
      'North Korea fires a ballistic missile toward the sea',
    ]);
  });
});

describe('namesHeadline', () => {
  it('matches the headline inside the owner\'s words, case and accents ignored', () => {
    expect(namesHeadline("tell me more about Spain's parliament rejects two housing bills in the news today", "Spain's parliament rejects two housing bills")).toBe(true);
    expect(namesHeadline('SPAIN PARLIAMENT REJECTS TWO HOUSING BILLS?', "Spain's parliament rejects two housing bills")).toBe(true);
    expect(namesHeadline('Le Sénat adopte la réforme des retraites', 'le senat adopte la reforme des retraites')).toBe(true);
  });
  it('matches 70% of the words in order, or a long run of them', () => {
    // 7 of 9 words, in order.
    expect(namesHeadline('what about north korea firing a ballistic missile at the sea', 'North Korea fires a ballistic missile toward the sea')).toBe(true);
    // Five words word for word inside a longer question.
    expect(namesHeadline('so the parliament rejects two housing bills, what now', 'Spain\'s parliament rejects two housing bills after a long night of debate')).toBe(true);
  });
  it('does not match a topic word or two, or the words out of order', () => {
    expect(namesHeadline('anything new on Brazil?', "Brazil heads into Sunday's election")).toBe(false);
    expect(namesHeadline('housing in Spain', "Spain's parliament rejects two housing bills")).toBe(false);
    expect(namesHeadline('bills housing two rejects parliament', "Spain's parliament rejects two housing bills")).toBe(false);
    expect(namesHeadline('North Korea', 'North Korea')).toBe(false);
  });
});

function edition(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (sql: string) => {
    if (/mission\.delivered/.test(sql)) return { rows };
    if (/owner_profile|owner_places/.test(sql)) return { rows: [] };
    return { rows: [] };
  });
  const ctx: CoreToolContext = {
    db: { query } as unknown as CoreToolContext['db'],
    ownerId: 'owner',
    timezone: 'Europe/Paris',
    now: () => new Date('2026-10-05T10:00:00Z'),
  };
  return { ctx, query };
}
const report = { agent_id: 'anchor', created_at: new Date('2026-10-05T05:00:00Z'), text: EDITION, link: '#/p/news/stories?edition=e_abc' };

describe('edition origin', () => {
  it("finds the story of today's edition the message names, in one query", async () => {
    const { ctx, query } = edition([report]);
    expect(await findEditionOrigin(ctx, "tell me more about spain's parliament rejecting two housing bills")).toEqual({
      headline: "Spain's parliament rejects two housing bills", agentId: 'anchor', plugin: 'news',
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("ignores yesterday's edition and a message that names no story", async () => {
    const { ctx } = edition([{ ...report, created_at: new Date('2026-10-04T05:00:00Z') }]);
    expect(await findEditionOrigin(ctx, "tell me more about spain's parliament rejects two housing bills")).toBeNull();
    const today = edition([report]);
    expect(await findEditionOrigin(today.ctx, 'what is on my calendar this afternoon?')).toBeNull();
  });
  it('does not query at all for a message of a word or two', async () => {
    const { ctx, query } = edition([report]);
    expect(await findEditionOrigin(ctx, 'thanks!')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it('words the way to read it for the agent asking: its own tool, a delegation, or the colleague to name', () => {
    const origin = { headline: "Spain's parliament rejects two housing bills", agentId: 'anchor', plugin: 'news' };
    const handle = () => 'anchor';
    expect(editionOriginLine(origin, { agentId: 'concierge', tools: ['agent.delegate'] }, handle)).toBe(
      `This message names "Spain's parliament rejects two housing bills", a story from today's edition by @anchor (News): delegate it to @anchor (agent.delegate, agent "anchor") before you say anything about it.`,
    );
    expect(editionOriginLine(origin, { agentId: 'concierge', tools: ['news.story', 'news.search'] }, handle)).toContain('read it with news.search');
    expect(editionOriginLine(origin, { agentId: 'concierge', tools: [] }, handle)).toContain('say @anchor has it');
  });
  it('adds the line to the platform context of the turn that names the story', async () => {
    const { ctx } = edition([report]);
    const prompt = (await systemContext(ctx, { agentId: 'concierge', tools: ['agent.delegate'], message: "tell me more about Spain's parliament rejects two housing bills in the news today" }, { handleOf: () => 'anchor' })).prompt;
    expect(prompt).toContain(`names "Spain's parliament rejects two housing bills", a story from today's edition by @anchor (News)`);
  });
});
