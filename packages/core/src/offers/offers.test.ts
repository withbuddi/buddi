/**
 * Offered actions: normalization, and the one branch that decides rendering.
 *
 * The rendering tests are the load-bearing ones. "Buttons on Telegram, chips on
 * the dashboard, plain text in the terminal" is a sentence about three
 * surfaces, and the whole point of doing it through `SurfaceProfile` is that
 * nothing here knows their names — so these assert that the *declared
 * capability* is what decides, including for a surface invented in the test.
 */
import { describe, expect, it } from 'vitest';
import {
  CLI_SURFACE,
  SCHEDULED_SURFACE,
  TELEGRAM_SURFACE,
  WEB_SURFACE,
  type SurfaceProfile,
} from '../surfaces.js';
import { describeOffers, OFFERS_PREAMBLE, renderOffers } from './render.js';
import { normalizeOffers } from './store.js';
import { MAX_OFFERS, MAX_OFFER_LABEL, MAX_OFFER_PROMPT, type Offer } from './types.js';

const offer = (label: string, id = label): Offer => ({
  id,
  agentId: 'mail-triage',
  conversationId: null,
  label,
  prompt: `${label}, please`,
  createdAt: '2026-09-15T09:00:00.000Z',
  expiresAt: '2026-09-22T09:00:00.000Z',
  takenAt: null,
  takenVia: null,
  takenJobId: null,
});

describe('normalizeOffers', () => {
  it('trims, drops the empty, and keeps at most the cap', () => {
    const out = normalizeOffers([
      { label: '  Draft a reply  ', prompt: '  Draft a reply to her  ' },
      { label: '', prompt: 'nothing to label this with' },
      { label: 'Remind me', prompt: '' },
      { label: 'Remind me tomorrow', prompt: 'Remind me tomorrow morning' },
      { label: 'Show the message', prompt: 'Show me the whole thing' },
      { label: 'A fourth', prompt: 'one too many' },
    ]);
    expect(out).toHaveLength(MAX_OFFERS);
    expect(out[0]).toEqual({ label: 'Draft a reply', prompt: 'Draft a reply to her' });
    expect(out.map((o) => o.label)).not.toContain('A fourth');
  });

  it('drops a duplicate label rather than drawing the same button twice', () => {
    const out = normalizeOffers([
      { label: 'Draft a reply', prompt: 'one' },
      { label: 'draft a REPLY', prompt: 'two' },
    ]);
    expect(out).toHaveLength(1);
  });

  it('clips a label and a prompt at the cap instead of refusing the report', () => {
    const out = normalizeOffers([
      { label: 'x'.repeat(200), prompt: 'y'.repeat(2000) },
    ]);
    expect(out[0]?.label.length).toBe(MAX_OFFER_LABEL);
    expect(out[0]?.prompt.length).toBe(MAX_OFFER_PROMPT);
  });
});

describe('renderOffers, per surface', () => {
  const offers = [offer('Draft a reply'), offer('Remind me tomorrow')];

  it('hands Telegram controls to draw, and leaves the text alone', () => {
    const out = renderOffers(TELEGRAM_SURFACE, 'Dorothée has retired.', offers);
    expect(out.controls).toHaveLength(2);
    expect(out.text).toBe('Dorothée has retired.');
    expect(out.text).not.toContain(OFFERS_PREAMBLE);
  });

  it('hands the dashboard controls to draw as chips', () => {
    const out = renderOffers(WEB_SURFACE, 'Dorothée has retired.', offers);
    expect(out.controls).toHaveLength(2);
    expect(out.text).toBe('Dorothée has retired.');
  });

  it('spells them out in the terminal, which has nothing to tap', () => {
    const out = renderOffers(CLI_SURFACE, 'Dorothée has retired.', offers);
    expect(out.controls).toHaveLength(0);
    expect(out.text).toContain(OFFERS_PREAMBLE);
    expect(out.text).toContain('- Draft a reply');
    expect(out.text).toContain('- Remind me tomorrow');
  });

  it('spells them out for a notification nobody can tap either', () => {
    const out = renderOffers(SCHEDULED_SURFACE, 'Dorothée has retired.', offers);
    expect(out.controls).toHaveLength(0);
    expect(out.text).toContain('- Draft a reply');
  });

  it('decides on the declared capability, not on the surface id', () => {
    // A surface this repository has never heard of. It renders correctly
    // because it *declared* what it is, which is the whole contract.
    const invented: SurfaceProfile = {
      ...CLI_SURFACE,
      id: 'smoke-signals',
      name: 'smoke signals',
      buttons: true,
    };
    expect(renderOffers(invented, 'hello', offers).controls).toHaveLength(2);
    expect(renderOffers({ ...invented, buttons: false }, 'hello', offers).text).toContain(
      '- Draft a reply',
    );
  });

  it('changes nothing when there is nothing offered', () => {
    for (const profile of [TELEGRAM_SURFACE, CLI_SURFACE, WEB_SURFACE, SCHEDULED_SURFACE]) {
      const out = renderOffers(profile, 'just the report', []);
      expect(out.text).toBe('just the report');
      expect(out.controls).toHaveLength(0);
    }
  });

  it('describeOffers says the same thing for actions with no ids yet', () => {
    const actions = [{ label: 'Draft a reply', prompt: 'draft it' }];
    expect(describeOffers(CLI_SURFACE, 'body', actions)).toContain('- Draft a reply');
    expect(describeOffers(TELEGRAM_SURFACE, 'body', actions)).toBe('body');
  });
});
