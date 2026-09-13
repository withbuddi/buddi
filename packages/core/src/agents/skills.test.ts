import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadSkillsDir,
  parseSkillFile,
  provenanceFooter,
  skillAdmits,
  skillsSection,
  SkillFileError,
} from './skills.js';

function skillFile(frontmatter: string, body = 'Do the thing carefully.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

const VERDICTS = skillFile(
  [
    'name: verdicts',
    'description: What a verdict must state.',
    'provenance: owner',
    'created: 2026-09-13',
  ].join('\n'),
  'Quote minBalance and its date.',
);

function skillsDir(files: Record<string, string>): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'buddi-skills-')), 'skills');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${name}.md`), content);
  }
  return dir;
}

describe('parseSkillFile', () => {
  it('reads frontmatter and body, defaulting provenance to owner', () => {
    const skill = parseSkillFile(skillFile('name: verdicts\ndescription: d'));
    expect(skill.name).toBe('verdicts');
    expect(skill.description).toBe('d');
    expect(skill.provenance).toBe('owner');
    expect(skill.source).toBeUndefined();
    expect(skill.body).toBe('Do the thing carefully.');
    expect(skill.scope).toBe('private');
  });

  it('keeps provenance, source and created when stated', () => {
    const skill = parseSkillFile(
      skillFile(
        [
          'name: recap',
          'description: d',
          'provenance: imported',
          'source: https://example.test/post',
          'created: 2026-09-13',
        ].join('\n'),
      ),
    );
    expect(skill.provenance).toBe('imported');
    expect(skill.source).toBe('https://example.test/post');
    expect(skill.created).toBe('2026-09-13');
  });

  it('accepts an agent-authored skill', () => {
    expect(
      parseSkillFile(skillFile('name: a\ndescription: d\nprovenance: agent')).provenance,
    ).toBe('agent');
  });

  it('refuses a skill that declares tools — a skill never grants a capability', () => {
    let caught: unknown;
    try {
      parseSkillFile(skillFile('name: a\ndescription: d\ntools: [finance.project_cashflow]'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SkillFileError);
    expect((caught as SkillFileError).code).toBe('grants-capability');
    expect((caught as Error).message).toMatch(/never grants a tool or lowers a tier/);
  });

  it('refuses a skill that declares a tier', () => {
    expect(() => parseSkillFile(skillFile('name: a\ndescription: d\ntier: auto'))).toThrow(
      /may not declare "tier"/,
    );
  });

  it('refuses an unknown key, an unknown provenance and a non-kebab name', () => {
    expect(() => parseSkillFile(skillFile('name: a\ndescription: d\nmaxTurns: 3'))).toThrow(
      SkillFileError,
    );
    expect(() => parseSkillFile(skillFile('name: a\ndescription: d\nprovenance: stolen'))).toThrow(
      SkillFileError,
    );
    expect(() => parseSkillFile(skillFile('name: Verdicts\ndescription: d'))).toThrow(/kebab-case/);
  });

  it('refuses a missing description, a missing frontmatter block and an empty body', () => {
    expect(() => parseSkillFile(skillFile('name: a'))).toThrow(/description/);
    expect(() => parseSkillFile('no frontmatter here')).toThrow(SkillFileError);
    expect(() => parseSkillFile('---\nname: a\ndescription: d\n---\n\n')).toThrow(/body is empty/);
  });

  it('refuses a name that is not its filename', () => {
    expect(() => parseSkillFile(VERDICTS, { fileName: 'status-overview' })).toThrow(
      /does not match its file/,
    );
  });

  it('reads a list of agents for a shared skill', () => {
    const skill = parseSkillFile(
      skillFile('name: a\ndescription: d\nagents: [finance-advisor, concierge]'),
      { scope: 'shared' },
    );
    expect(skill.agents).toEqual(['finance-advisor', 'concierge']);
    expect(skill.scope).toBe('shared');
  });
});

describe('loadSkillsDir', () => {
  it('discovers every markdown file in sorted name order', () => {
    const dir = skillsDir({
      verdicts: VERDICTS,
      'status-overview': skillFile('name: status-overview\ndescription: d'),
    });
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const skills = loadSkillsDir(dir, 'private');
    expect(skills.map((s) => s.name)).toEqual(['status-overview', 'verdicts']);
    expect(skills.every((s) => s.scope === 'private')).toBe(true);
    expect(skills[1]?.file.endsWith('verdicts.md')).toBe(true);
  });

  it('treats a missing directory as no skills, not an error', () => {
    expect(loadSkillsDir('/nope/not/here', 'shared')).toEqual([]);
  });

  it('fails closed on a malformed file, naming the file', () => {
    const dir = skillsDir({ broken: 'no frontmatter' });
    expect(() => loadSkillsDir(dir, 'private')).toThrow(/broken\.md/);
  });

  it('fails closed on a name that is not its filename', () => {
    const dir = skillsDir({ 'status-overview': VERDICTS });
    expect(() => loadSkillsDir(dir, 'private')).toThrow(/does not match its file/);
  });
});

describe('skillAdmits', () => {
  const of = (agents?: string[]) =>
    parseSkillFile(
      skillFile(`name: a\ndescription: d${agents ? `\nagents: [${agents.join(', ')}]` : ''}`),
    );

  it('admits any agent when no filter is stated', () => {
    expect(skillAdmits(of(), 'anyone')).toBe(true);
  });

  it('admits only the listed agents when a filter is stated', () => {
    expect(skillAdmits(of(['concierge']), 'concierge')).toBe(true);
    expect(skillAdmits(of(['concierge']), 'finance-advisor')).toBe(false);
  });
});

describe('skillsSection', () => {
  const verdicts = parseSkillFile(VERDICTS);
  const house = parseSkillFile(
    skillFile('name: house\ndescription: d\nprovenance: agent\nsource: run 42', 'Be brief.'),
  );

  it('is empty when there are no skills', () => {
    expect(skillsSection([])).toBe('');
  });

  it('renders a heading and a provenance footer per skill', () => {
    const section = skillsSection([verdicts, house]);
    expect(section.startsWith('# SKILLS')).toBe(true);
    expect(section).toContain('## verdicts\nQuote minBalance and its date.');
    expect(section).toContain('(skill: verdicts, provenance: owner)');
    expect(section).toContain('## house\nBe brief.');
    expect(section).toContain('(skill: house, provenance: agent, source: run 42)');
    expect(section).toContain('it never grants you a tool and never lowers a tier');
    expect(section.indexOf('## verdicts')).toBeLessThan(section.indexOf('## house'));
  });

  it('omits the source when a skill has none', () => {
    expect(provenanceFooter(verdicts)).toBe('(skill: verdicts, provenance: owner)');
  });
});
