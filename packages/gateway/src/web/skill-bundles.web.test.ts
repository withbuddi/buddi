/**
 * Skill bundles, server side (skill-bundles.ts, skills.ts): the zip checks
 * (a bomb, a path that climbs, a link, no SKILL.md, too many files, too big,
 * a program outside scripts/), then upload → staged preview → accept → list
 * → sheet (tree, a file's text, a picture's size only, download as .zip),
 * Edit SKILL.md, Mark as mine, delete; the picker's "can run its scripts"
 * agents; the prompt's paths; and host.exec's card context and untrusted
 * refusal through the resolver serve wires.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { asksEachTime, loadAgentCatalog } from '@buddi/core';
import { isToolRefusal, type ToolContext } from '@buddi/core/plugin';
import { HostService, execInput } from '@buddi/tool-host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createToolRegistry, EXAMPLES_AGENTS_DIR, EXAMPLES_SKILLS_DIR, reloadableCatalog } from '../agents/catalog.js';
import { BUNDLE_MAX_FILES, readStaged, stageBundle, type Refusal, type StagedBundle } from './skill-bundles.js';
import {
  acceptBundleRoute,
  deleteSkillRoute,
  editSkillRoute,
  listSkillsRoute,
  skillBundlesFor,
  skillDetailRoute,
  skillDownload,
  skillFileRoute,
  stagedFileRoute,
  trustSkillRoute,
  type SkillRow,
  type SkillsAgent,
  type SkillsDeps,
} from './skills.js';

const agentFile = (id: string, tools = '[]'): string =>
  `---\nid: ${id}\nhandle: ${id}\nname: ${id.charAt(0).toUpperCase() + id.slice(1)}\ndescription: The ${id}.\ntools: ${tools}\n---\n\nYou are ${id}. Today is {{today}}.\n`;

const SKILL_MD = '---\nname: cover-art-kit\ndescription: When I ask for a cover, a poster or album art with a title on it.\nlicense: MIT\nmetadata:\n  author: someone\n---\n\n# Cover art kit\n\nMake a square cover with the title set in the kit’s fonts.\n\n1. Run `scripts/make_cover.py`.\n';

function coverKit(extra: Zippable = {}): Zippable {
  return {
    'cover-art-kit/SKILL.md': strToU8(SKILL_MD),
    'cover-art-kit/assets/palette.json': strToU8('{"ground":"#152642"}\n'),
    'cover-art-kit/assets/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    'cover-art-kit/scripts/make_cover.py': [strToU8('print("cover")\n'), { os: 3, attrs: (0o100755 << 16) >>> 0 }],
    'cover-art-kit/scripts/setup.sh': strToU8('#!/bin/sh\npip install pillow\n'),
    ...extra,
  };
}

describe('skill bundles, server side', () => {
  let root: string;
  let agentsDir: string;
  let skillsDir: string;
  let incomingDir: string;
  let deps: SkillsDeps;

  const write = (file: string, text: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const stage = (zip: Zippable | Uint8Array, filename = 'cover-art-kit.zip') => {
    const file = path.join(root, `${Math.random()}.zip`);
    writeFileSync(file, zip instanceof Uint8Array ? zip : zipSync(zip));
    return stageBundle(incomingDir, file, filename, new Date('2026-10-03T10:00:00Z'));
  };
  const staged = (zip: Zippable): StagedBundle => {
    const out = stage(zip);
    expect(out.status).toBe(200);
    return (out.body as { staged: StagedBundle }).staged;
  };
  const refused = (zip: Zippable | Uint8Array, filename?: string): Refusal => {
    const out = stage(zip, filename);
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(readdirSync(incomingDir).filter((n) => !n.endsWith('.zip'))).toEqual([]);
    return (out.body as { refusal: Refusal }).refusal;
  };
  const rows = (): SkillRow[] => (listSkillsRoute(deps).body as { skills: SkillRow[] }).skills;
  const agents = (): SkillsAgent[] => (listSkillsRoute(deps).body as { agents: SkillsAgent[] }).agents;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'buddi-bundles-web-'));
    agentsDir = path.join(root, 'agents');
    skillsDir = path.join(root, 'skills');
    incomingDir = path.join(root, '.incoming', 'skills');
    mkdirSync(incomingDir, { recursive: true });
    write(path.join(agentsDir, 'dev', 'agent.md'), agentFile('dev', '[host.exec]'));
    write(path.join(agentsDir, 'ledger', 'agent.md'), agentFile('ledger'));
    const registry = createToolRegistry({});
    const catalog = reloadableCatalog(() =>
      loadAgentCatalog({
        dirs: [
          { dir: EXAMPLES_AGENTS_DIR, skillsDir: EXAMPLES_SKILLS_DIR, source: 'example' },
          { dir: agentsDir, skillsDir, source: 'private' },
        ],
        registry,
        env: {},
        log: () => {},
      }),
    );
    deps = { catalog, agentsDir, skillsDir, incomingDir, trashRoot: path.join(root, '.trash'), plugins: () => [], now: () => new Date('2026-10-03T10:00:00Z') };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe('checks a zip before anything is kept', () => {
    it('refuses an entry that climbs out, an absolute path, and a link, unpacking nothing', () => {
      const r = refused(coverKit({ '../../.zshrc': strToU8('evil'), 'cover-art-kit/scripts/python': [strToU8('/usr/bin/python3'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }), 'tools.zip');
      expect(r.kind).toBe('paths');
      expect(r.entries).toEqual([
        expect.objectContaining({ path: '../../.zshrc', why: 'climbs out of the folder' }),
        expect.objectContaining({ path: 'cover-art-kit/scripts/python', why: 'is a link', target: '/usr/bin/python3' }),
      ]);
      expect(refused({ '/etc/passwd': strToU8('x'), 'SKILL.md': strToU8(SKILL_MD) }).entries?.[0]?.why).toBe('is an absolute path');
    });

    it('refuses a zip bomb: a member that inflates past what it declares', () => {
      const zip = zipSync({ 'SKILL.md': strToU8(SKILL_MD), 'assets/zeros.bin': new Uint8Array(4 * 1024 * 1024) });
      // Patch the central directory's uncompressed size of the second entry down to 100 bytes.
      const view = new DataView(zip.buffer);
      let at = zip.length - 22;
      while (view.getUint32(at, true) !== 0x06054b50) at -= 1;
      let cd = view.getUint32(at + 16, true);
      for (let n = 0; n < 2; n += 1) {
        const nameLength = view.getUint16(cd + 28, true);
        const name = strFromU8(zip.subarray(cd + 46, cd + 46 + nameLength));
        if (name === 'assets/zeros.bin') view.setUint32(cd + 24, 100, true);
        cd += 46 + nameLength + view.getUint16(cd + 30, true) + view.getUint16(cd + 32, true);
      }
      const r = refused(zip);
      expect(r.kind).toBe('big');
    });

    it('refuses a file and a folder of the same name as damaged, not as a server error', () => {
      for (const extra of <Zippable[]>[
        { 'cover-art-kit/assets/a': strToU8('x'), 'cover-art-kit/assets/a/b.txt': strToU8('y') },
        { 'cover-art-kit/assets/c/d.txt': strToU8('y'), 'cover-art-kit/assets/c': strToU8('x') },
      ]) {
        const out = stage(coverKit(extra));
        expect(out.status).toBe(422);
        expect((out.body as { refusal: Refusal }).refusal.kind).toBe('damaged');
        expect(readdirSync(incomingDir).filter((n) => !n.endsWith('.zip'))).toEqual([]);
      }
    });

    it('refuses a zip with no SKILL.md, saying where it looked', () => {
      const r = refused({ 'photo-tools-main/README.md': strToU8('hi'), 'photo-tools-main/scripts/a.py': strToU8('') }, 'photo-tools.zip');
      expect(r).toMatchObject({ kind: 'noskill', looked: ['', 'photo-tools-main/'] });
    });

    it('refuses too many files, too much unpacked, a program outside scripts/, and front matter without a description', () => {
      const many: Zippable = { 'SKILL.md': strToU8(SKILL_MD) };
      for (let i = 0; i < BUNDLE_MAX_FILES; i += 1) many[`assets/f${i}.txt`] = strToU8('x');
      expect(refused(many)).toMatchObject({ kind: 'count', files: BUNDLE_MAX_FILES + 1 });
      expect(refused({ 'SKILL.md': strToU8(SKILL_MD), 'assets/big.bin': new Uint8Array(21 * 1024 * 1024) })).toMatchObject({ kind: 'big' });
      expect(refused(coverKit({ 'cover-art-kit/assets/run.sh': strToU8('rm -rf ~') })).entries?.[0]).toMatchObject({ path: 'assets/run.sh' });
      expect(refused(coverKit({ 'cover-art-kit/assets/tool': [new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 2]), {}] })).entries?.[0]).toMatchObject({ path: 'assets/tool', why: 'is a program' });
      expect(refused({ 'SKILL.md': strToU8('---\nname: x\n---\n\nSteps.\n') }).kind).toBe('frontmatter');
      expect(refused(new Uint8Array([1, 2, 3, 4]), 'cover.zip').kind).toBe('notzip');
    });

    it('reads a good one: SKILL.md inside one folder, the files with scripts flagged, nothing run', () => {
      const s = staged(coverKit());
      expect(s.skill).toMatchObject({ name: 'cover-art-kit', title: 'Cover art kit', description: 'When I ask for a cover, a poster or album art with a title on it.' });
      expect(s.files.map((f) => [f.path, f.kind, f.setup ?? false])).toEqual([
        ['SKILL.md', 'skill', false],
        ['assets/logo.png', 'image', false],
        ['assets/palette.json', 'data', false],
        ['scripts/make_cover.py', 'script', false],
        ['scripts/setup.sh', 'script', true],
      ]);
      expect(s.scripts).toEqual(['scripts/make_cover.py', 'scripts/setup.sh']);
      expect(stagedFileRoute(deps, s.id, 'scripts/setup.sh').body).toMatchObject({ file: { text: '#!/bin/sh\npip install pillow\n', setup: true } });
      expect(stagedFileRoute(deps, s.id, 'assets/logo.png').body).toMatchObject({ file: { binary: true, image: true } });
      expect(stagedFileRoute(deps, s.id, '../meta.json').status).toBe(404);
      expect(rows()).toEqual([]);
    });
  });

  it('upload → accept → list → sheet → edit → mark as mine → delete', async () => {
    const s = staged(coverKit());
    const accepted = acceptBundleRoute(deps, s.id, { agents: ['dev', 'ledger'] });
    expect(accepted.status).toBe(201);
    expect(readStaged(incomingDir, s.id)).toBeNull();
    const dir = path.join(skillsDir, 'cover-art-kit');
    expect(existsSync(path.join(dir, 'scripts', 'make_cover.py'))).toBe(true);
    const skillText = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(skillText).toContain('untrusted: true');
    expect(skillText).toContain('source: upload/cover-art-kit.zip');
    expect(skillText).not.toContain('license');

    const row = rows().find((r) => r.id === 'cover-art-kit')!;
    expect(row).toMatchObject({ group: 'mine', untrusted: 'upload', bundle: { files: 4, scripts: ['scripts/make_cover.py', 'scripts/setup.sh'] } });
    expect(row.holders.map((h) => h.agent).sort()).toEqual(['dev', 'ledger']);
    expect(agents().filter((a) => a.canRunScripts).map((a) => a.id)).toEqual(['dev']);

    const detail = skillDetailRoute(deps, 'cover-art-kit').body as { bundle: { files: Array<{ path: string }>; scripts: string[] } };
    expect(detail.bundle.files.map((f) => f.path)).toEqual(['SKILL.md', 'assets/logo.png', 'assets/palette.json', 'scripts/make_cover.py', 'scripts/setup.sh']);
    expect(skillFileRoute(deps, 'cover-art-kit', 'assets/palette.json').body).toMatchObject({ file: { kind: 'data', text: '{"ground":"#152642"}\n' } });
    const download = skillDownload(deps, 'cover-art-kit');
    expect(download && 'zip' in download ? Object.keys(unzipSync(download.zip)).sort() : []).toEqual([
      'cover-art-kit/SKILL.md', 'cover-art-kit/assets/logo.png', 'cover-art-kit/assets/palette.json', 'cover-art-kit/scripts/make_cover.py', 'cover-art-kit/scripts/setup.sh',
    ]);

    // The prompt: dev can run (once trusted), ledger reads the text only.
    const devPrompt = deps.catalog.get('dev')!.systemPromptTemplate;
    expect(devPrompt).toContain(`Its files are in ${dir} (read-only)`);
    expect(devPrompt).toContain('cannot run until the owner marks the bundle as theirs');

    expect(editSkillRoute(deps, 'cover-art-kit', { body: '# Cover art kit\n\nNew steps.' }).status).toBe(200);
    expect(readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toContain('New steps.');
    expect(trustSkillRoute(deps, 'cover-art-kit').status).toBe(200);
    expect(deps.catalog.get('dev')!.systemPromptTemplate).toContain('call host.exec with skill: { bundle: "cover-art-kit"');
    expect(deps.catalog.get('ledger')!.systemPromptTemplate).toContain('you have no tool that runs them');

    const gone = await deleteSkillRoute(deps, 'cover-art-kit');
    expect(gone.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync((gone.body as { movedTo: string }).movedTo)).toBe(true);
  });

  it('host.exec: the card carries the bundle context once marked as mine, and refuses before that', async () => {
    const s = staged(coverKit());
    acceptBundleRoute(deps, s.id, { agents: ['dev'] });
    const service = new HostService({});
    service.useSkillBundles(skillBundlesFor(deps));
    service.confinement = () => 'macos-sandbox';
    const ctx = { agentId: 'dev', conversationId: 'c-1', buddi: { owner: { id: 'o' }, dir: { legacyPath: path.join(root, 'data') } } } as unknown as ToolContext;
    const run = execInput.parse({ skill: { bundle: 'cover-art-kit', script: 'scripts/make_cover.py', args: ['--title', 'Night Train'] } });
    await expect(service.describe(run, ctx)).rejects.toSatisfy((err: unknown) => isToolRefusal(err) && /cannot run/.test((err as Error).message));
    trustSkillRoute(deps, 'cover-art-kit');
    const { envelope } = await service.describe(run, ctx);
    expect(envelope.skillRun).toMatchObject({ bundle: 'cover-art-kit', title: 'Cover art kit', script: 'scripts/make_cover.py', args: ['--title', 'Night Train'], files: 5 });
    expect(asksEachTime(envelope)).toBe(true);
    // Ledger holds nothing of the kind.
    const ledger = { ...ctx, agentId: 'ledger' } as ToolContext;
    await expect(service.describe(run, ledger)).rejects.toSatisfy((err: unknown) => isToolRefusal(err));
  });
});
