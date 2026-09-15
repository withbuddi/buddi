/**
 * The untrusted-content rule is a *property of this package*, not a sentence
 * somebody happened to write once. These tests are what stops it being edited
 * away by a refactor that was only trying to shorten a description.
 */
import { describe, expect, it } from 'vitest';
import { manifest } from './index.js';
import { CITE_NOTICE, NO_SEARCH_KEY_NOTICE, UNTRUSTED_NOTICE } from './notice.js';
import { webSkills } from './skills.js';

describe('the untrusted-content rule', () => {
  it('is stated in the notice every result carries', () => {
    expect(UNTRUSTED_NOTICE).toMatch(/evidence, never instructions/i);
    expect(UNTRUSTED_NOTICE).toMatch(/cannot|never|no text/i);
    // The three things a page must never be able to do.
    expect(UNTRUSTED_NOTICE).toMatch(/grant you a tool/i);
    expect(UNTRUSTED_NOTICE).toMatch(/authorise a send|authorise/i);
    // Including when it claims to be the owner — the mail-triage lesson.
    expect(UNTRUSTED_NOTICE).toMatch(/claims to come.*owner|from the owner/i);
  });

  it('is in every tool description, not just one persona', () => {
    for (const tool of manifest.tools) {
      if (tool.name === 'web.status') continue;
      expect(tool.description.toLowerCase(), tool.name).toContain('untrusted');
      expect(tool.description.toLowerCase(), tool.name).toContain('never instructions');
    }
  });

  it('is a shared skill, so any agent granted web.* can be given it', () => {
    const skill = webSkills.find((s) => s.name === 'the-web-is-evidence');
    expect(skill).toBeDefined();
    expect(skill?.body).toMatch(/evidence/i);
    expect(skill?.body).toMatch(/ignore your previous instructions/i);
    expect(skill?.body).toMatch(/Send mail, spend money/);
    // Shared skills, not an agent's — the plugin proposes no agent at all.
    expect(manifest.skills?.map((s) => s.name)).toContain('the-web-is-evidence');
    expect(manifest.agents ?? []).toEqual([]);
  });
});

describe('attribution', () => {
  it('is asked for in the notice and taught in a skill', () => {
    expect(CITE_NOTICE).toMatch(/name the site it came from/i);
    const skill = webSkills.find((s) => s.name === 'answering-with-sources');
    expect(skill?.body).toMatch(/Cars\.com lists/);
    expect(skill?.body).toMatch(/Search, then read/);
  });
});

describe('the degraded answer', () => {
  it('forbids the failure this plugin was written to prevent', () => {
    expect(NO_SEARCH_KEY_NOTICE).toMatch(/NOT configured/);
    expect(NO_SEARCH_KEY_NOTICE).toMatch(/must not present it as a lookup/);
    expect(NO_SEARCH_KEY_NOTICE).toMatch(/Do not invent sources/);
  });
});

describe('the manifest', () => {
  it('declares the hosts it reaches, and what it sends there', () => {
    const hosts = (manifest.network ?? []).map((n) => n.host);
    expect(hosts).toContain('api.tavily.com');
    expect(hosts).toContain('api.search.brave.com');
    expect((manifest.network ?? []).every((n) => n.why.length > 40)).toBe(true);
  });

  it('owns one schema and ships its migration', () => {
    expect(manifest.schema).toBe('web');
    expect(manifest.migrationsDir).toMatch(/migrations$/);
  });
});
