/**
 * The surface contract.
 *
 * The paragraph is the whole feature: it is what the model reads instead of
 * whatever sentence a surface felt like appending. So these tests check two
 * things about it — that every declared fact is *stated*, and that nothing else
 * is. A paragraph that quietly claimed a canvas would be the exact failure this
 * file exists to prevent, on the one surface where the claim is false.
 */
import { describe, expect, it } from 'vitest';
import {
  CLI_SURFACE,
  SCHEDULED_SURFACE,
  SURFACE_PROFILES,
  SURFACE_SECTION_HEADING,
  surfaceSection,
  TELEGRAM_SURFACE,
  WEB_SURFACE,
  type SurfaceProfile,
} from './surfaces.js';

const bullets = (profile: SurfaceProfile): string[] =>
  surfaceSection(profile).split('\n').slice(1);

describe('surfaceSection', () => {
  it('opens with the generated heading and one line per declared fact', () => {
    for (const profile of SURFACE_PROFILES) {
      const section = surfaceSection(profile);
      expect(section.startsWith(`${SURFACE_SECTION_HEADING}\n`)).toBe(true);
      // Eight facts, eight sentences. A ninth line would be prose nothing reads.
      expect(bullets(profile)).toHaveLength(8);
      expect(bullets(profile).every((line) => line.startsWith('- '))).toBe(true);
    }
  });

  it('names the surface the way the agent may say it out loud', () => {
    expect(surfaceSection(TELEGRAM_SURFACE)).toContain('You are answering on Telegram.');
    expect(surfaceSection(CLI_SURFACE)).toContain('You are answering on the terminal.');
    expect(surfaceSection(WEB_SURFACE)).toContain('You are answering on the dashboard.');
  });

  it('states Telegram honestly: no markdown, no tables, a cap, buttons, a person, no canvas', () => {
    const section = surfaceSection(TELEGRAM_SURFACE);
    expect(section).toContain('Markdown is not rendered here');
    expect(section).toContain('Tables do not render here.');
    expect(section).toContain('One message holds at most 4000 characters here.');
    expect(section).toContain('Files can be sent and received here.');
    expect(section).toContain('The owner can tap a button here');
    expect(section).toContain('There is no canvas here');
    expect(section).toContain('The owner is here now and can answer you.');
    // The claim that must never appear on this surface.
    expect(section).not.toContain('There is a canvas here');
    expect(section).not.toContain('Markdown is rendered here');
  });

  it('states the terminal honestly: markdown renders, no cap, no button, no canvas', () => {
    const section = surfaceSection(CLI_SURFACE);
    expect(section).toContain('Markdown is rendered here');
    expect(section).toContain('Tables render here as a grid.');
    expect(section).toContain('There is no limit on how long one message may be here.');
    expect(section).toContain('There is no button to tap here.');
    expect(section).toContain('There is no canvas here');
    expect(section).not.toContain('There is a canvas here');
  });

  it('is the only profile that tells the agent it has a canvas', () => {
    const withCanvas = SURFACE_PROFILES.filter((p) =>
      surfaceSection(p).includes('There is a canvas here'),
    );
    expect(withCanvas).toEqual([WEB_SURFACE]);
    expect(surfaceSection(WEB_SURFACE)).toContain(
      'There is a canvas here: a panel beside the conversation that can hold a chart, a table or a document you build.',
    );
  });

  it('tells a scheduled run that nobody is there to answer it', () => {
    const section = surfaceSection(SCHEDULED_SURFACE);
    expect(section).toContain(
      'Nobody is here: this text is delivered as a notification and cannot be answered.',
    );
    expect(section).not.toContain('can answer you');
    expect(section).toContain('There is no button to tap here.');
    expect(section).toContain('No file can be sent or received here.');
    expect(section).toContain('One message holds at most 1500 characters here.');
  });

  it('derives every sentence from the profile, with no per-surface special case', () => {
    // A profile nobody ships renders exactly like the shipped ones: if any
    // sentence were hard-coded per id, this made-up surface would lose it.
    const invented: SurfaceProfile = {
      id: 'smoke-signal',
      name: 'the smoke signal',
      markdown: false,
      tables: false,
      maxMessageChars: 12,
      attachments: false,
      buttons: false,
      canvas: false,
      interactive: false,
    };
    expect(bullets(invented)).toHaveLength(8);
    expect(surfaceSection(invented)).toContain('You are answering on the smoke signal.');
    expect(surfaceSection(invented)).toContain('One message holds at most 12 characters here.');
  });

  it('ships four profiles with distinct ids', () => {
    expect(SURFACE_PROFILES.map((p) => p.id)).toEqual([
      'telegram',
      'cli',
      'web',
      'scheduled',
    ]);
  });
});
