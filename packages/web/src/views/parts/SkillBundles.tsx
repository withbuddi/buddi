/**
 * Skills, part 2: bundles — a SKILL.md with scripts/ and assets/ beside it.
 *
 * The kit's SkillBundles.jsx is the source. Here: the glyphs (drawn for this
 * page in the product's line style; not in the icon set yet, as the kit
 * flags), the file tree with its viewer (shared by the bundle's sheet and the
 * upload's preview), the upload sheet's drop zone with its refusals in place,
 * and the preview of what a .zip holds before anything is kept.
 *
 * Nothing in a bundle runs on upload, ever. A script runs only when an agent
 * holding host.exec runs it, asking the owner each time, and never while the
 * bundle is untrusted; every place a bundle shows says so.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatAgent } from '../../chat/types';
import { ApiError } from '../../api';
import { Avatar, Button, Code, ErrorBanner, KV, Notice, Sheet, Spacer, Toolbar } from '../../ui';
import {
  BUNDLE_MAX_BYTES,
  BundleRefused,
  andList,
  refusalWords,
  sizeWords,
  skillsApi,
  type BundleFile,
  type BundleFileKind,
  type BundleFileView,
  type BundleRefusal,
  type SkillRow,
  type SkillsAgent,
  type StagedBundle,
} from './skills-data';

/** The tool a bundle's scripts run through. */
export const SCRIPT_TOOL = 'host.exec';

/* ------------------------------------------------------------------ *
 * glyphs
 * ------------------------------------------------------------------ */

const GLYPHS = {
  bundle: [20, 1.6, <><path d="M3.4 6.4 10 3.2l6.6 3.2v7.2L10 16.8l-6.6-3.2Z" /><path d="M3.4 6.4 10 9.6l6.6-3.2M10 9.6v7.2" /></>],
  folder: [16, 1.5, <path d="M2.2 4.4a1 1 0 0 1 1-1h3l1.4 1.6h5.2a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1Z" />],
  doc: [16, 1.5, <><path d="M4.4 1.9h4.8l3 3v8.2a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V2.9a1 1 0 0 1 1-1Z" /><path d="M9 2v3h3" /></>],
  script: [16, 1.5, <><rect x="1.9" y="2.6" width="12.2" height="10.8" rx="1.4" /><path d="m4.6 6.4 2 1.6-2 1.6M8.4 10h3" /></>],
  font: [16, 1.5, <path d="M3.4 13 8 3l4.6 10M5 9.6h6" />],
  image: [16, 1.5, <><rect x="2" y="2.6" width="12" height="10.8" rx="1.4" /><circle cx="5.8" cy="6.2" r="1.2" /><path d="m2.4 12 3.8-3.6 2.6 2.4 2-1.8 3 2.6" /></>],
  upload: [20, 1.6, <><path d="M10 13.2V3.6M6.2 7.2 10 3.4l3.8 3.8" /><path d="M3.6 12.6v2.6a1.4 1.4 0 0 0 1.4 1.4h10a1.4 1.4 0 0 0 1.4-1.4v-2.6" /></>],
  shield: [16, 1.5, <><path d="M8 1.8 13 3.6v4c0 3-2.1 5.4-5 6.6-2.9-1.2-5-3.6-5-6.6v-4Z" /><path d="m5.8 8 1.6 1.6 2.8-3" /></>],
} as const;

export type BundleGlyphName = keyof typeof GLYPHS;

export function BundleGlyph({ name, size }: { name: BundleGlyphName; size?: number }): JSX.Element {
  const [grid, stroke, body] = GLYPHS[name];
  return (
    <svg width={size ?? grid} height={size ?? grid} viewBox={`0 0 ${grid} ${grid}`} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {body}
    </svg>
  );
}

/** A bundle's lead on a row or a sheet title: the box, where a one-file skill has the page. */
export function BundleLead({ size }: { size?: 'lg' }): JSX.Element {
  return (
    <span className="ui-app-icon" data-size={size} aria-hidden="true">
      <BundleGlyph name="bundle" size={size ? 22 : 18} />
    </span>
  );
}

const KIND_GLYPH: Record<BundleFileKind, BundleGlyphName> = { skill: 'doc', script: 'script', font: 'font', image: 'image', data: 'doc', template: 'doc', other: 'doc' };
const KIND_WORD: Record<BundleFileKind, string> = { skill: 'The skill', script: 'Script', font: 'Font', image: 'Picture', data: 'Data', template: 'Template', other: 'File' };

/* ------------------------------------------------------------------ *
 * the file tree
 * ------------------------------------------------------------------ */

type TreeRow = { dir: string; name: string; depth: number } | { file: BundleFile; name: string; depth: number };

function treeRows(files: readonly BundleFile[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const sorted = [...files].sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
  for (const f of sorted) {
    const parts = f.path.split('/');
    parts.slice(0, -1).forEach((_, i) => {
      const dir = parts.slice(0, i + 1).join('/');
      if (!seen.has(dir)) {
        seen.add(dir);
        rows.push({ dir, name: `${parts[i]}/`, depth: i });
      }
    });
    rows.push({ file: f, name: parts[parts.length - 1] as string, depth: parts.length - 1 });
  }
  return rows;
}

/** Folders as quiet rows, files indented under them; a script says so. Picking a file shows it beside. */
export function BundleTree({
  files,
  selected,
  onSelect,
}: {
  files: readonly BundleFile[];
  selected: string;
  /** Null while SKILL.md is being edited: the tree holds still. */
  onSelect: ((path: string) => void) | null;
}): JSX.Element {
  return (
    <ul className="skb-tree" role={onSelect ? 'listbox' : undefined} aria-label="Files in the bundle">
      {treeRows(files).map((r) =>
        'dir' in r ? (
          <li key={`d:${r.dir}`} className="skb-node" data-dir="true" data-depth={Math.min(r.depth, 6)}>
            <BundleGlyph name="folder" size={14} />
            <span className="skb-name">{r.name}</span>
          </li>
        ) : (
          <li
            key={r.file.path}
            className="skb-node"
            data-depth={Math.min(r.depth, 6)}
            data-kind={r.file.kind}
            data-selected={selected === r.file.path ? 'true' : undefined}
            role={onSelect ? 'option' : undefined}
            aria-selected={onSelect ? selected === r.file.path : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onClick={onSelect ? () => onSelect(r.file.path) : undefined}
            onKeyDown={
              onSelect
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(r.file.path);
                    }
                  }
                : undefined
            }
          >
            <BundleGlyph name={KIND_GLYPH[r.file.kind]} size={14} />
            <span className="skb-name" title={r.file.path}>{r.name}</span>
            {r.file.kind === 'script' ? <span className="skb-flag">{r.file.setup ? 'setup' : 'script'}</span> : null}
            <span className="skb-size">{sizeWords(r.file.size)}</span>
          </li>
        ),
      )}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * the viewer
 * ------------------------------------------------------------------ */

/** What a script's note says about who can run it. */
export interface ScriptReach {
  /** The agents using it that hold host.exec. */
  run: string[];
  /** Anybody uses it at all. */
  held: boolean;
  untrusted: boolean;
}

function scriptNote(file: BundleFile, reach: ScriptReach): string {
  const setup = file.setup ? 'A setup script. It didn’t run when you uploaded the bundle and never runs on its own. ' : '';
  if (reach.untrusted) return `${setup}It can’t run until you mark the bundle as yours. Then it runs only when an agent you allow runs it with ${SCRIPT_TOOL}, and asks you first.`;
  if (reach.run.length) {
    return `${setup}It runs only when ${andList(reach.run)} ${reach.run.length > 1 ? 'run' : 'runs'} it with ${SCRIPT_TOOL}, and asks you first. It can read this bundle’s files, not change them.`;
  }
  if (reach.held) return `${setup}Nobody holding this skill can run scripts, so it never runs.`;
  return `${setup}It runs only when an agent you allow runs it, and asks you first. It can read the bundle’s files, not change them.`;
}

/**
 * One file, as the workspace's Files tab would show it: SKILL.md through the
 * caller's own viewer (Read · Source, or the editor), the rest read here —
 * text as code, a picture drawn, a font or anything else as its size.
 */
export function BundleViewer({
  file,
  skillView,
  read,
  imageUrl,
  reach,
}: {
  file: BundleFile;
  skillView: ReactNode;
  read: (path: string) => Promise<{ file: BundleFileView }>;
  imageUrl: (path: string) => string;
  reach: ScriptReach;
}): JSX.Element {
  const [view, setView] = useState<{ path: string; file?: BundleFileView; error?: string } | null>(null);
  useEffect(() => {
    if (file.kind === 'skill') return;
    let live = true;
    setView({ path: file.path });
    read(file.path).then(
      (r) => { if (live) setView({ path: file.path, file: r.file }); },
      (err: unknown) => { if (live) setView({ path: file.path, error: err instanceof ApiError ? err.message : String(err) }); },
    );
    return () => { live = false; };
    // `read` is a fresh closure every render; the path is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path, file.kind]);

  if (file.kind === 'skill') return <div className="skb-view">{skillView}</div>;
  const loaded = view?.path === file.path ? view.file : undefined;
  return (
    <div className="skb-view">
      <div className="skills-text-bar">
        <span className="skb-view-kind">{KIND_WORD[file.kind]} · {sizeWords(file.size)}</span>
        <span className="skills-file mono">{file.path}</span>
      </div>
      {file.kind === 'script' ? (
        <p className="skb-script-note">
          <BundleGlyph name="shield" size={14} />
          <span>{scriptNote(file, reach)}</span>
        </p>
      ) : null}
      {view?.error ? (
        <ErrorBanner message={view.error} />
      ) : file.kind === 'font' ? (
        <div className="skb-blank"><BundleGlyph name="font" size={20} /><span>A font. The skill’s scripts or documents set text with it; there’s nothing to read here.</span></div>
      ) : file.kind === 'image' && loaded?.image ? (
        <div className="skb-picture"><img src={imageUrl(file.path)} alt={file.path} /></div>
      ) : !loaded ? (
        <p className="skills-note">Reading the file…</p>
      ) : loaded.binary || loaded.text === undefined ? (
        <div className="skb-blank"><BundleGlyph name="doc" size={20} /><span>Not text, so there’s nothing to read here. {sizeWords(file.size)}.</span></div>
      ) : (
        <Code label={file.path}>{loaded.text}</Code>
      )}
    </div>
  );
}

/** The tree beside the viewer, as one block; stacked on a phone. */
export function BundleFiles({ children }: { children: ReactNode }): JSX.Element {
  return <div className="skb-files">{children}</div>;
}

/** The promise the sheet and the picker make about scripts. */
export function ScriptsPromise({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="skb-promise">
      <BundleGlyph name="shield" size={16} />
      <span>{children}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ *
 * upload: the drop zone, then what's inside before anything is kept
 * ------------------------------------------------------------------ */

const LIMITS = 'Up to 20 MB and 500 files. Nothing in it runs when you upload it.';

/**
 * The upload sheet: a drop zone taking a .zip or a .md. A .md goes to the
 * one-file form as before; a .zip is sent, checked by buddi and answered
 * with its preview — or refused in place with what buddi saw.
 */
export function SkillDrop({
  initialRefusal,
  onClose,
  onMd,
  onStaged,
}: {
  initialRefusal?: BundleRefusal | null;
  onClose: () => void;
  onMd: (file: File) => void;
  onStaged: (staged: StagedBundle) => void;
}): JSX.Element {
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<BundleRefusal | null>(initialRefusal ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const take = (f: File | null | undefined): void => {
    if (!f || busy) return;
    setError(null);
    if (/\.md$/i.test(f.name)) {
      onMd(f);
      return;
    }
    if (!/\.zip$/i.test(f.name)) {
      setRefused({ kind: 'notzip', filename: f.name });
      return;
    }
    if (f.size > BUNDLE_MAX_BYTES) {
      setRefused({ kind: 'big', filename: f.name, size: f.size });
      return;
    }
    setBusy(f.name);
    skillsApi.uploadBundle(f).then(
      (staged) => onStaged(staged),
      (err: unknown) => {
        setBusy(null);
        if (err instanceof BundleRefused) setRefused(err.refusal);
        else setError(err instanceof ApiError ? err.message : String(err));
      },
    );
  };
  const words = refused ? refusalWords(refused) : null;
  return (
    <Sheet title="Upload a skill" onClose={onClose}>
      <input
        ref={input}
        type="file"
        accept=".zip,.md,application/zip,text/markdown"
        hidden
        data-testid="skill-drop-file"
        onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }}
      />
      <div className="skills-sheet skb-drop-sheet">
        {words ? (
          <Notice tone="critical" title={words.title} role="alert">
            <div className="skb-refusal">
              {words.body}
              {words.items?.length ? (
                <ul className="skb-refused">
                  {words.items.map((i) => <li key={i.path}><span className="mono">{i.path}</span> {i.rest}</li>)}
                </ul>
              ) : null}
            </div>
          </Notice>
        ) : null}
        <ErrorBanner message={error} />
        <div
          className="skb-drop"
          data-over={over ? 'true' : undefined}
          data-testid="skill-drop"
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}
        >
          <span className="skb-drop-glyph"><BundleGlyph name="upload" size={24} /></span>
          <span className="skb-drop-title">
            {busy ? `Reading “${busy}”…` : over ? 'Drop to read it' : words ? 'Drop another file here' : 'Drop a .zip or a .md here'}
          </span>
          <Button variant={words ? undefined : 'accent'} disabled={busy !== null} onClick={() => input.current?.click()}>
            {words ? 'Choose another file' : 'Choose a file'}
          </Button>
          <span className="skb-drop-limits">{LIMITS}</span>
        </div>
        <section className="skills-sec skb-shape" aria-label="What a bundle looks like">
          <h3 className="skills-sec-title">What a bundle looks like</h3>
          <dl className="skb-shape-tree">
            <dt className="mono">cover-art-kit/</dt><dd />
            <dt className="mono" data-in="true">SKILL.md</dt><dd>the skill: a name, when it’s used, the steps</dd>
            <dt className="mono" data-in="true">scripts/</dt><dd>run only by an agent you allow, asking first</dd>
            <dt className="mono" data-in="true">assets/</dt><dd>fonts, templates, pictures it reads</dd>
          </dl>
        </section>
      </div>
    </Sheet>
  );
}

function CheckRow({ checked, onChange, lead, title, sub }: { checked: boolean; onChange: (on: boolean) => void; lead?: ReactNode; title: ReactNode; sub?: ReactNode }): JSX.Element {
  return (
    <label className="skills-pick-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {lead}
      <span className="skills-pick-text">
        <span className="skills-pick-title">{title}</span>
        {sub ? <span className="skills-pick-sub">{sub}</span> : null}
      </span>
    </label>
  );
}

/** What a .zip holds, read before anything is kept: SKILL.md, the files with scripts flagged, who uses it, Mark as mine. */
export function ZipPreview({
  staged,
  agents,
  faces,
  onClose,
  onBack,
  onAdded,
}: {
  staged: StagedBundle;
  agents: readonly SkillsAgent[];
  faces: readonly ChatAgent[];
  onClose: () => void;
  onBack: () => void;
  onAdded: (row: SkillRow) => void;
}): JSX.Element {
  const scripts = staged.files.filter((f) => f.kind === 'script');
  const [file, setFile] = useState<string>(scripts.find((f) => f.setup)?.path ?? scripts[0]?.path ?? 'SKILL.md');
  const [who, setWho] = useState<string[]>([]);
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runners = agents.filter((a) => a.canRunScripts).map((a) => a.name);
  const current = staged.files.find((f) => f.path === file) ?? (staged.files[0] as BundleFile);
  const leave = (then: () => void): void => {
    // Not kept: the staged copy goes now rather than in an hour.
    void skillsApi.discardBundle(staged.id).catch(() => undefined);
    then();
  };
  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { skill } = await skillsApi.acceptBundle(staged.id, { agents: who, mine });
      onAdded(skill);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  };
  const setup = scripts.some((f) => f.setup);
  return (
    <Sheet
      size="wide"
      title={
        <span className="skills-sheet-title">
          <BundleLead size="lg" />
          <span className="skills-sheet-name">
            <span>{staged.filename}</span>
            <span className="skills-sheet-by">{staged.files.length} files · {sizeWords(staged.size)} unpacked · read, not saved yet</span>
          </span>
        </span>
      }
      onClose={() => leave(onClose)}
      foot={
        <Toolbar>
          <Button variant="ghost" onClick={() => leave(onBack)}>Choose another file</Button>
          <Spacer />
          <Button variant="ghost" onClick={() => leave(onClose)}>Cancel</Button>
          <Button variant="accent" disabled={busy} onClick={() => void add()}>Add the skill</Button>
        </Toolbar>
      }
    >
      {scripts.length ? (
        <Notice title={`${scripts.length} script${scripts.length > 1 ? 's' : ''} inside. None of them ran.`}>
          They run later only when an agent you allow runs them, after you mark the bundle as yours, and each run asks you first{setup ? ' — setup scripts too.' : '.'}
        </Notice>
      ) : null}
      <ErrorBanner message={error} />
      <div className="skills-sheet">
        <section className="skills-sec" aria-label="From its SKILL.md">
          <header className="skills-sec-head"><h3 className="skills-sec-title">From its SKILL.md</h3></header>
          <KV
            items={[
              { label: 'Name', value: staged.skill.title },
              { label: 'When it’s used', value: staged.skill.description },
              { label: 'First lines', value: <span className="skb-first">{staged.skill.firstLines}{staged.skill.firstLines.length >= 160 ? '…' : ''}</span> },
            ]}
          />
        </section>
        <section className="skills-sec" aria-label="What’s inside">
          <header className="skills-sec-head">
            <h3 className="skills-sec-title">What’s inside</h3>
            <span className="skills-sec-aside skills-note">{sizeWords(staged.size)} unpacked · {sizeWords(staged.packed)} as a .zip</span>
          </header>
          <BundleFiles>
            <BundleTree files={staged.files} selected={current.path} onSelect={setFile} />
            <BundleViewer
              file={current}
              read={(p) => skillsApi.stagedFile(staged.id, p)}
              imageUrl={(p) => skillsApi.stagedImageUrl(staged.id, p)}
              reach={{ run: [], held: false, untrusted: false }}
              skillView={<StagedSkillText staged={staged} />}
            />
          </BundleFiles>
          <p className="skills-note">Checked: every file stays inside the bundle, no links, nothing over the limits. Pick a file to read it before you add it.</p>
        </section>
        <section className="skills-sec" aria-label="Who uses it">
          <header className="skills-sec-head"><h3 className="skills-sec-title">Who uses it</h3></header>
          <div className="skills-who">
            {agents.filter((a) => a.writable).map((a) => (
              <CheckRow
                key={a.id}
                checked={who.includes(a.id)}
                onChange={(on) => setWho(on ? [...who, a.id] : who.filter((x) => x !== a.id))}
                lead={<Avatar id={a.id} name={a.name} size="sm" face={faces.find((f) => f.id === a.id)} />}
                title={a.name}
                sub={a.canRunScripts && scripts.length ? 'can run scripts' : undefined}
              />
            ))}
          </div>
          <p className="skills-note">
            {scripts.length
              ? runners.length
                ? `Only ${andList(runners)} ${runners.length > 1 ? 'have' : 'has'} a tool that runs scripts; the others read the text. You can change this later.`
                : 'No agent has a tool that runs scripts, so they all read the text only. You can change this later.'
              : 'You can change this later. With nobody ticked it’s kept and does nothing.'}
          </p>
        </section>
        <section className="skills-sec">
          <label className="plugins-check">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            <span>
              <span className="plugins-check-title">Mark as mine</span>
              <span className="plugins-check-hint">
                {scripts.length
                  ? 'I wrote it, or I’ve read it and its scripts and trust them. Otherwise agents read its text as outside text and its scripts can’t run.'
                  : 'I wrote it, or I’ve read it and trust it. Otherwise agents read its text as outside text.'}
              </span>
            </span>
          </label>
        </section>
      </div>
    </Sheet>
  );
}

/** SKILL.md in the preview: the file as it came, read from staging. */
function StagedSkillText({ staged }: { staged: StagedBundle }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    skillsApi.stagedFile(staged.id, 'SKILL.md').then((r) => { if (live) setText(r.file.text ?? ''); }, () => { if (live) setText(''); });
    return () => { live = false; };
  }, [staged.id]);
  return (
    <>
      <div className="skills-text-bar">
        <span className="skb-view-kind">The skill</span>
        <span className="skills-file mono">SKILL.md</span>
      </div>
      {text === null ? <p className="skills-note">Reading the file…</p> : <Code label="SKILL.md">{text}</Code>}
    </>
  );
}
