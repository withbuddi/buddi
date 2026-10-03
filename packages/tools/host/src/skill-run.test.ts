/**
 * host.exec's `skill` form: a bundle script's card context, the refusals
 * (untrusted, not held, not a script, no confinement, a plain command
 * reaching into the skills folder), and the confinement itself where this
 * computer has one.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isToolRefusal, type ToolContext } from '@buddi/core/plugin';
import { HostService, execInput } from './service.js';
import { runCommand } from './process.js';
import { confinementArgv, detectConfinement, type SkillBundleView, type SkillBundles } from './skill-run.js';

describe('host.exec runs a bundle script', () => {
  let root: string;
  let skillsDir: string;
  let service: HostService;
  let trusted: boolean;
  let networked = false;
  const ctx = (): ToolContext => ({
    agentId: 'dev', conversationId: 'c-1',
    buddi: { owner: { id: 'owner-1' }, dir: { legacyPath: path.join(root, 'data') } },
  }) as unknown as ToolContext;
  const view = (): SkillBundleView => ({
    name: 'cover-art', title: 'Cover art kit', dir: path.join(skillsDir, 'cover-art'), untrusted: !trusted, network: networked,
    files: ['SKILL.md', 'assets/palette.json', 'scripts/make_cover.py', 'scripts/setup.sh'], scripts: ['scripts/make_cover.py', 'scripts/setup.sh'],
  });
  const bundles: SkillBundles = {
    held: (agentId, name) => (agentId === 'dev' && name === 'cover-art' ? view() : null),
    root: () => skillsDir,
  };
  const input = (raw: Record<string, unknown>) => execInput.parse(raw);

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'buddi-skill-run-'));
    skillsDir = path.join(root, 'skills');
    mkdirSync(path.join(skillsDir, 'cover-art', 'scripts'), { recursive: true });
    writeFileSync(path.join(skillsDir, 'cover-art', 'scripts', 'make_cover.py'), 'print("cover")\n');
    service = new HostService({});
    service.useSkillBundles(bundles);
    service.confinement = () => 'macos-sandbox';
    trusted = true;
    networked = false;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('describes the run with its bundle context: script, arguments, working folder, what it may touch', async () => {
    const { envelope, preview } = await service.describe(input({ skill: { bundle: 'cover-art', script: 'scripts/make_cover.py', args: ['--title', 'Night Train'] } }), ctx());
    const work = path.join(root, 'data', 'skill-runs', 'cover-art');
    expect(envelope.skillRun).toMatchObject({
      bundle: 'cover-art', title: 'Cover art kit', script: 'scripts/make_cover.py', interpreter: 'python3',
      args: ['--title', 'Night Train'], reads: path.join(skillsDir, 'cover-art'), files: 4, untrusted: false, confinement: 'macos-sandbox',
    });
    expect(envelope.skillRun!.writes.startsWith(work)).toBe(true);
    expect(envelope.cwd).toBe(envelope.skillRun!.writes);
    expect(envelope.command).toBe(`python3 '${path.join(skillsDir, 'cover-art', 'scripts', 'make_cover.py')}' '--title' 'Night Train'`);
    expect(envelope.skillRun!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(preview).toContain('asks every time');
    expect(preview).toContain('writes only in the working folder');
  });

  const refusal = async (raw: Record<string, unknown>): Promise<string> => {
    try {
      await service.describe(input(raw), ctx());
    } catch (err) {
      expect(isToolRefusal(err)).toBe(true);
      return (err as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('refuses while the bundle is untrusted, before anyone is asked', async () => {
    trusted = false;
    expect(await refusal({ skill: { bundle: 'cover-art', script: 'scripts/make_cover.py' } })).toMatch(/has not marked it as theirs, so its scripts cannot run/);
  });

  it('refuses a bundle the agent does not hold, a file that is not a script, and a path that climbs', async () => {
    expect(await refusal({ skill: { bundle: 'other', script: 'scripts/x.py' } })).toMatch(/do not hold a skill bundle called "other"/);
    expect(await refusal({ skill: { bundle: 'cover-art', script: 'assets/palette.json' } })).toMatch(/not one of Cover art kit's scripts/);
    expect(await refusal({ skill: { bundle: 'cover-art', script: 'scripts/../../evil.py' } })).toMatch(/not one of/);
  });

  it('refuses when this computer cannot confine a script', async () => {
    service.confinement = () => null;
    expect(await refusal({ skill: { bundle: 'cover-art', script: 'scripts/make_cover.py' } })).toMatch(/no way to confine a script/);
  });

  it('refuses to run a script that changed after it was approved', async () => {
    const raw = { skill: { bundle: 'cover-art', script: 'scripts/make_cover.py' } };
    const { envelope } = await service.describe(input(raw), ctx());
    writeFileSync(path.join(skillsDir, 'cover-art', 'scripts', 'make_cover.py'), 'import os; os.system("curl evil")\n');
    let asserted = false;
    const approved = {
      ...ctx(), actionId: 'a-1', approvedEffect: { envelope },
      buddi: { ...(ctx().buddi as object), approvals: { assert: () => { asserted = true; } } },
    } as unknown as ToolContext;
    const err = await service.execute(input(raw), approved).then(() => null, (e: unknown) => e as Error);
    expect(err && isToolRefusal(err)).toBe(true);
    expect(err!.message).toMatch(/scripts\/make_cover\.py in Cover art kit changed after it was approved, so nothing ran/);
    expect(asserted).toBe(false);
  });

  it('says on the card what the confinement does not hold', async () => {
    const { preview } = await service.describe(input({ skill: { bundle: 'cover-art', script: 'scripts/make_cover.py' } }), ctx());
    expect(preview).toContain('none of your own files');
    expect(preview).toContain('Network: off.');
    expect(preview).not.toContain('Network as host commands have it');
    networked = true;
    const asked = await service.describe(input({ skill: { bundle: 'cover-art', script: 'scripts/make_cover.py' } }), ctx());
    expect(asked.envelope.skillRun!.network).toBe(true);
    expect(asked.preview).toContain('Network: on');
  });

  it('refuses both or neither of command and skill, and a plain command reaching into the skills folder', async () => {
    expect(await refusal({ command: 'ls', skill: { bundle: 'cover-art', script: 'scripts/make_cover.py' } })).toMatch(/either a command or skill/);
    expect(await refusal({})).toMatch(/either a command or skill/);
    expect(await refusal({ command: `python3 ${path.join(skillsDir, 'cover-art', 'scripts', 'make_cover.py')}` })).toMatch(/reaches into the skills folder/);
    // Relative paths, a cd before, a ~ path and a cwd inside the folder are caught as well.
    expect(await refusal({ command: 'python3 skills/cover-art/scripts/make_cover.py', cwd: root })).toMatch(/reaches into the skills folder/);
    expect(await refusal({ command: `cd '${root}' && sh ./skills/cover-art/scripts/setup.sh` })).toMatch(/reaches into the skills folder/);
    expect(await refusal({ command: 'python3 scripts/make_cover.py', cwd: path.join(skillsDir, 'cover-art') })).toMatch(/reaches into the skills folder/);
    expect(await refusal({ command: `cat "${path.relative(path.join(root, 'data'), skillsDir)}/cover-art/SKILL.md"`, cwd: path.join(root, 'data') })).toMatch(/reaches into the skills folder/);
    const plain = await service.describe(input({ command: 'echo hi' }), ctx());
    expect(plain.envelope.skillRun).toBeUndefined();
  });
});

describe.skipIf(detectConfinement() === null)('the confinement a bundle script runs in', () => {
  it('reads the bundle, writes in its working folder, and cannot write anywhere else', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'buddi-confine-')));
    try {
      const bundle = path.join(root, 'bundle');
      const work = path.join(root, 'work');
      mkdirSync(bundle);
      mkdirSync(work);
      writeFileSync(path.join(bundle, 'palette.json'), '{"a":1}');
      const kind = detectConfinement()!;
      const result = await runCommand({
        command: `cat '${bundle}/palette.json' > out.json && echo changed > '${bundle}/palette.json'; echo "rc=$?"`,
        cwd: work, timeoutMs: 10_000, env: process.env, wrap: confinementArgv(kind, work, { bundle }),
      });
      expect(readFileSync(path.join(work, 'out.json'), 'utf8')).toBe('{"a":1}');
      expect(readFileSync(path.join(bundle, 'palette.json'), 'utf8')).toBe('{"a":1}');
      expect(result.stdout).toContain('rc=1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs python, node and sh scripts, and on macOS cannot start open or osascript', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'buddi-confine-')));
    try {
      const bundle = path.join(root, 'bundle');
      const work = path.join(root, 'work');
      mkdirSync(bundle);
      mkdirSync(work);
      writeFileSync(path.join(bundle, 'a.py'), 'import json, os\nopen("py.txt", "w").write(json.dumps({"ok": True}))\nprint("py ok")\n');
      writeFileSync(path.join(bundle, 'a.js'), 'require("fs").writeFileSync("js.txt", "ok"); console.log("node ok");\n');
      writeFileSync(path.join(bundle, 'a.sh'), 'echo ok > sh.txt; echo sh ok\n');
      const kind = detectConfinement()!;
      const run = (command: string, interpreter = 'sh', network = false) =>
        runCommand({ command, cwd: work, timeoutMs: 20_000, env: process.env, wrap: confinementArgv(kind, work, { bundle, interpreter, network }) });
      expect((await run(`python3 '${bundle}/a.py'`, 'python3')).stdout).toContain('py ok');
      expect((await run(`node '${bundle}/a.js'`, 'node')).stdout).toContain('node ok');
      expect((await run(`sh '${bundle}/a.sh'`)).stdout).toContain('sh ok');
      // Nothing of the user's is readable: a secret beside the bundle stays unread.
      writeFileSync(path.join(root, 'secret.txt'), 'hunter2');
      expect((await run(`cat '${root}/secret.txt'; echo "rc=$?"`)).stdout).not.toContain('hunter2');
      // No network unless the bundle asked for it.
      const fetchJs = `require("net").connect(443, "1.1.1.1").on("connect", () => { console.log("net on"); process.exit(0); }).on("error", (e) => { console.log("net off " + e.code); process.exit(0); })`;
      writeFileSync(path.join(bundle, 'net.js'), fetchJs);
      expect((await run(`node '${bundle}/net.js'`, 'node')).stdout).toMatch(/net off/);
      expect(readFileSync(path.join(work, 'py.txt'), 'utf8')).toBe('{"ok": true}');
      if (kind === 'macos-sandbox') {
        expect((await run(`/usr/bin/osascript -e 'return 1'; echo "rc=$?"`)).stdout).toContain('rc=126');
        expect((await run(`/usr/bin/open -g -a Calculator; echo "rc=$?"`)).stdout).toContain('rc=126');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
