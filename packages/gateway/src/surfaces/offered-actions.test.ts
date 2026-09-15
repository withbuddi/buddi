/**
 * What an interactive turn may offer, and the restraint written around it.
 *
 * Three properties, and they are the whole point of the module:
 *
 *  - a turn **declares** what it offers through a tool, exactly as it declares
 *    a question — no text rule guesses a button out of prose;
 *  - the declaration **authorizes nothing**: it writes rows and returns a
 *    count, and there is no path from here to an effect;
 *  - a turn that declares nothing is **unchanged** — no rows, no controls, and
 *    not one word added to the reply.
 *
 * No database: an in-memory `Queryable` that records the SQL it was handed.
 */
import {
  CLI_SURFACE,
  MAX_OFFERS,
  TELEGRAM_SURFACE,
  WEB_SURFACE,
  renderOffers,
  type Offer,
  type Queryable,
} from '@buddi/core';
import { describe, expect, it } from 'vitest';
import {
  OFFER_POLICY_SUFFIX,
  OFFER_TOOL,
  OFFER_TOOLS,
  createOfferManifest,
  storeTurnOffers,
  withdrawTurnOffers,
  type OfferSink,
} from './offered-actions.js';

const NOW = new Date('2026-09-15T10:00:00.000Z');

class FakeDb implements Queryable {
  readonly sql: string[] = [];
  fail = false;
  rows: Record<string, unknown>[] = [];

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.sql.push(text);
    if (this.fail) throw new Error('the offers table is unreachable');
    if (text.startsWith('insert into core.offers')) {
      return {
        rows: [
          {
            id: `offer-${this.sql.length}`,
            agent_id: params[0],
            conversation_id: params[1],
            label: params[2],
            prompt: params[3],
            created_at: params[4],
            expires_at: params[5],
            taken_at: null,
            taken_via: null,
            taken_job_id: null,
          },
        ],
      };
    }
    if (text.startsWith('update core.offers')) return { rows: this.rows };
    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }
}

const tool = (sink: OfferSink) => {
  const manifest = createOfferManifest(sink);
  const definition = manifest.tools[0];
  if (!definition) throw new Error('the manifest declares no tool');
  return definition;
};

describe('an interactive turn declaring the actions it offers', () => {
  it('registers one auto tool, under the name a turn calls', () => {
    const sink: OfferSink = {};
    const definition = tool(sink);
    expect(definition.name).toBe(OFFER_TOOL);
    expect(OFFER_TOOLS).toEqual([OFFER_TOOL]);
    // `auto` is right and unremarkable: it writes nothing outside this run's
    // sink. Everything that could have an effect is downstream of a *tap*.
    expect(definition.tier).toBe('auto');
  });

  it('records what the turn offered, trimmed, and says how many', async () => {
    const sink: OfferSink = {};
    const result = await tool(sink).execute(
      {
        actions: [
          { label: ' Send it ', prompt: '  send the reply I drafted to Dorothée ' },
          { label: 'Edit the draft', prompt: 'change the second paragraph of that reply' },
        ],
      } as never,
      {} as never,
    );
    expect(result).toEqual({ offered: 2 });
    expect(sink.offered).toEqual([
      { label: 'Send it', prompt: 'send the reply I drafted to Dorothée' },
      { label: 'Edit the draft', prompt: 'change the second paragraph of that reply' },
    ]);
  });

  it('refuses a menu: at most three, at least one', () => {
    const schema = tool({}).input;
    const four = {
      actions: Array.from({ length: MAX_OFFERS + 1 }, (_, i) => ({
        label: `Do ${i}`,
        prompt: `do the ${i}th thing`,
      })),
    };
    expect(schema.safeParse(four).success).toBe(false);
    expect(schema.safeParse({ actions: [] }).success).toBe(false);
    expect(
      schema.safeParse({ actions: [{ label: 'Send it', prompt: 'send it' }] }).success,
    ).toBe(true);
  });

  it('says in the tool itself that it is rare, and that it authorizes nothing', () => {
    const description = tool({}).description;
    expect(description).toMatch(/only when/i);
    expect(description).toMatch(/authorizes nothing/i);
    expect(description).toMatch(/approval/i);
    // The restraint is in the policy too, not only in a persona somewhere.
    expect(OFFER_POLICY_SUFFIX).toMatch(/rare/i);
    expect(OFFER_POLICY_SUFFIX).toMatch(/authorizes nothing/i);
    expect(OFFER_POLICY_SUFFIX).toMatch(/never offer a synonym for "ok"/i);
  });
});

describe('storing what a turn offered', () => {
  it('writes nothing at all when the turn offered nothing', async () => {
    const db = new FakeDb();
    const stored = await storeTurnOffers(db, {
      sink: {},
      agentId: 'postman',
      conversationId: 'conv-1',
      now: NOW,
    });
    expect(stored).toEqual([]);
    expect(db.sql).toEqual([]);
  });

  it('writes one row per action, bound to the agent and the conversation', async () => {
    const db = new FakeDb();
    const stored = await storeTurnOffers(db, {
      sink: { offered: [{ label: 'Send it', prompt: 'send the reply I drafted' }] },
      agentId: 'postman',
      conversationId: 'conv-1',
      now: NOW,
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      agentId: 'postman',
      conversationId: 'conv-1',
      label: 'Send it',
      prompt: 'send the reply I drafted',
    });
  });

  it('never fails the turn when the store is unreachable — no buttons, not a broken one', async () => {
    const db = new FakeDb();
    db.fail = true;
    const lines: string[] = [];
    const stored = await storeTurnOffers(db, {
      sink: { offered: [{ label: 'Send it', prompt: 'send it' }] },
      agentId: 'postman',
      conversationId: 'conv-1',
      now: NOW,
      log: (line) => lines.push(line),
    });
    expect(stored).toEqual([]);
    expect(lines.join(' ')).toMatch(/unreachable/);
  });

  it('withdraws the previous turn’s offers, and survives a store that is down', async () => {
    const db = new FakeDb();
    db.rows = [{ id: 'a' }, { id: 'b' }];
    expect(await withdrawTurnOffers(db, 'conv-1', NOW)).toBe(2);
    expect(db.sql[0]).toMatch(/^update core\.offers set expires_at/);
    expect(db.sql[0]).toMatch(/taken_at is null/);

    db.fail = true;
    expect(await withdrawTurnOffers(db, 'conv-1', NOW)).toBe(0);
  });
});

describe('how one set of offers reaches two different surfaces', () => {
  const offers: Offer[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      agentId: 'postman',
      conversationId: 'conv-1',
      label: 'Send it',
      prompt: 'send the reply I drafted to Dorothée',
      createdAt: NOW.toISOString(),
      expiresAt: NOW.toISOString(),
      takenAt: null,
      takenVia: null,
      takenJobId: null,
    },
  ];

  it('is controls where the surface has buttons and words where it does not', () => {
    // The same rows, the same function, two profiles — and no surface id is
    // consulted anywhere in the decision.
    for (const profile of [TELEGRAM_SURFACE, WEB_SURFACE]) {
      const drawn = renderOffers(profile, 'The draft is ready.', offers);
      expect(drawn.controls).toEqual(offers);
      expect(drawn.text).toBe('The draft is ready.');
    }
    const terminal = renderOffers(CLI_SURFACE, 'The draft is ready.', offers);
    expect(terminal.controls).toEqual([]);
    expect(terminal.text).toContain('Send it');
  });

  it('leaves a turn that offered nothing exactly as it was, on every surface', () => {
    for (const profile of [TELEGRAM_SURFACE, WEB_SURFACE, CLI_SURFACE]) {
      const drawn = renderOffers(profile, 'The draft is ready.', []);
      expect(drawn).toEqual({ text: 'The draft is ready.', controls: [] });
    }
  });
});
