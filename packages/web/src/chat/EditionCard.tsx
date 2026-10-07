/**
 * A news edition in chat (the kit's News.jsx, "edition in chat"): when a
 * report's link names a saved edition (`#/p/news/stories?edition=<id>`), the
 * report is drawn as the edition card — its name and time, the voice note, its
 * first sentence, each topic with its stories (the outlet's logo, Anchor's
 * headline with UPDATE or OPINION, the line, the outlet linked out and "and N
 * more"), and the next edition's time. The data is the news plugin's
 * `edition` page query; the text as sent stays one tap away ("Show as text"),
 * and is what is drawn when the query has nothing to say.
 *
 * Logos come from buddi's own plugin-assets route only (`AssetImage`); a link
 * out is http(s) only. Every string is a React text child.
 *
 * One logo per story, the outlet Anchor named (the kit's choice): "and N
 * more" says the rest. Each story the edition told carries the kit's ⋯ ways
 * out, which the plugin declares as page actions (label, tool, args, the
 * sentence once done, the call that undoes it) in its answer: the card knows
 * no plugin tool, it runs what it is handed through the page-action route the
 * plugin pages use, and the story then leaves its sentence and Undo in place.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { AssetImage, assetSrc } from '../pages/AssetImage';
import { ActionMenu, Button, ButtonLink, Modal, Icon } from '../ui';
import { AudioCard, clock, useAudioPlayer } from './AudioCard';
import { downloadUrl } from './attachments';
import { downloadMp3 } from './download-audio';
import type { ReportView } from './report';

/** The plugin that saves editions, and its read-back. */
const NEWS = 'news';
const EDITION_QUERY = 'edition';

/** The edition a report's link names, or null. */
export function editionIdOf(route: string | null | undefined): string | null {
  if (!route) return null;
  const m = /^#\/p\/news\/stories\?(.*)$/.exec(route);
  if (!m) return null;
  const id = new URLSearchParams(m[1]).get('edition');
  return id && /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : null;
}

export interface EditionStory {
  mark?: 'update' | 'opinion';
  markLabel?: string;
  title: string;
  lead: string;
  outlet: string;
  more: number;
  link?: { url: string; label: string };
  logos: Array<{ name: string; logo?: string }>;
  topicName?: string;
  /** The ⋯ menu the plugin declared for a story the edition told; none for one it did not match. */
  actions?: EdAction[];
}

/**
 * One way out, as the plugin declared it in the page grammar: the tool and its
 * arguments (`{ const }` literals), the line under it, the heading above its
 * group, a question to confirm first, what it says once done, and the call
 * that takes it back.
 */
export interface EdAction {
  label: string;
  hint?: string;
  group?: string;
  tool: string;
  args: Record<string, unknown>;
  confirm?: string;
  done: string;
  undo?: { tool: string; label: string; args: Record<string, unknown> };
}

export interface Edition {
  id: string;
  name: string;
  when: string;
  lede: string;
  groups: Array<{ topic: string; stories: EditionStory[] }>;
  notes: string[];
  next?: string;
  /** The closing line, the plugin's own words (1.33); without it only the notes close the card. */
  foot?: string;
  /** The page link the plugin filed this digest's report under (1.33): its recording is found from it. */
  report?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isWeb = (url: string): boolean => /^https?:\/\/[^\s]+$/i.test(url);
const TOOL = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A declared call's arguments: each a `{ const }` literal, or the call is dropped. */
function constArgs(v: unknown): Record<string, unknown> | null {
  const raw = obj(v);
  if (!raw) return null;
  const out: Record<string, unknown> = {};
  for (const [key, ref] of Object.entries(raw)) {
    const r = obj(ref);
    if (!r || !('const' in r)) return null;
    out[key] = r['const'];
  }
  return out;
}

/** A story's declared ways out, read defensively: an item with a bad tool or argument is left out. */
export function edActions(v: unknown): EdAction[] {
  return (Array.isArray(v) ? v : []).flatMap((a): EdAction[] => {
    const r = obj(a);
    if (!r) return [];
    const label = str(r['label']).trim();
    const tool = str(r['tool']);
    const args = constArgs(r['args'] ?? {});
    if (label === '' || !TOOL.test(tool) || !args) return [];
    const u = obj(r['undo']);
    const undoArgs = u ? constArgs(u['args'] ?? {}) : null;
    const undo = u && TOOL.test(str(u['tool'])) && undoArgs ? { tool: str(u['tool']), label: str(u['label']).trim() || 'Undo', args: undoArgs } : null;
    const hint = str(r['hint']).trim();
    const group = str(r['group']).trim();
    const confirm = str(r['confirm']).trim();
    return [{
      label, tool, args,
      ...(hint ? { hint } : {}),
      ...(group ? { group } : {}),
      ...(confirm ? { confirm } : {}),
      done: str(r['done']).trim() || 'Done.',
      ...(undo ? { undo } : {}),
    }];
  }).slice(0, 12);
}

/** The query's answer, read defensively: anything off is left out, nothing is trusted to be a string. */
export function editionOf(data: unknown): Edition | null {
  const e = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)['edition'] : null;
  if (e === null || typeof e !== 'object') return null;
  const r = e as Record<string, unknown>;
  const groups = (Array.isArray(r['groups']) ? r['groups'] : []).flatMap((g): Edition['groups'] => {
    if (g === null || typeof g !== 'object') return [];
    const stories = (Array.isArray((g as Record<string, unknown>)['stories']) ? ((g as Record<string, unknown>)['stories'] as unknown[]) : []).flatMap((s): EditionStory[] => {
      if (s === null || typeof s !== 'object') return [];
      const o = s as Record<string, unknown>;
      const title = str(o['title']).trim();
      if (title === '') return [];
      const link = o['link'] !== null && typeof o['link'] === 'object' ? (o['link'] as Record<string, unknown>) : null;
      const url = link ? str(link['url']) : '';
      const mark = o['mark'] === 'update' || o['mark'] === 'opinion' ? o['mark'] : undefined;
      const topicName = str(o['topicName']).trim();
      const actions = edActions(o['actions']);
      return [{
        ...(mark ? { mark, markLabel: str(o['markLabel']) || undefined } : {}),
        title,
        lead: str(o['lead']),
        outlet: str(o['outlet']),
        more: typeof o['more'] === 'number' && Number.isFinite(o['more']) && o['more'] > 0 ? Math.floor(o['more']) : 0,
        ...(isWeb(url) ? { link: { url, label: str(link!['label']) || url } } : {}),
        logos: (Array.isArray(o['logos']) ? o['logos'] : []).flatMap((l) => {
          if (l === null || typeof l !== 'object') return [];
          const name = str((l as Record<string, unknown>)['name']);
          const logo = str((l as Record<string, unknown>)['logo']);
          return name ? [{ name, ...(logo ? { logo } : {}) }] : [];
        }),
        ...(topicName ? { topicName } : {}),
        ...(actions.length > 0 ? { actions } : {}),
      }];
    });
    return stories.length > 0 ? [{ topic: str((g as Record<string, unknown>)['topic']), stories }] : [];
  });
  if (groups.length === 0) return null;
  const next = str(r['next']);
  return {
    id: str(r['id']),
    name: str(r['name']) || 'Edition',
    when: str(r['when']),
    lede: str(r['lede']),
    groups,
    notes: (Array.isArray(r['notes']) ? r['notes'] : []).filter((n): n is string => typeof n === 'string' && n.trim() !== ''),
    ...(/^\d{1,2}:\d{2}$/.test(next) ? { next } : {}),
    ...(str(r['foot']).trim() ? { foot: str(r['foot']).trim() } : {}),
    ...(/^#\/p\/[a-z][a-z0-9_-]{0,63}\//.test(str(r['report'])) ? { report: str(r['report']) } : {}),
  };
}

type MenuItem = { label: string; hint?: string; onSelect: () => void } | { heading: string } | 'separator';

/** The menu's items, hairlines between the groups (an item without a group is grouped with its tool's). */
function menuItems(actions: EdAction[], onPick: (action: EdAction) => void): MenuItem[] {
  const items: MenuItem[] = [];
  let group: string | null = null;
  actions.forEach((action, i) => {
    const g = action.group ?? action.tool;
    if (i > 0 && g !== group) items.push('separator');
    if (action.group && g !== group) items.push({ heading: action.group });
    group = g;
    items.push({ label: action.label, ...(action.hint ? { hint: action.hint } : {}), onSelect: () => onPick(action) });
  });
  return items;
}

/** What a picked way left in the story's place. */
interface Gone { text: string; undo?: NonNullable<EdAction['undo']> }

function EdStory({ s, plugin }: { s: EditionStory; plugin: string }): JSX.Element {
  const [gone, setGone] = useState<Gone | null>(null);
  const first = s.logos[0] ?? { name: s.outlet || s.title };
  const outlet = s.outlet || first.name;
  const [asking, setAsking] = useState<EdAction | null>(null);
  const actions = s.actions ?? [];

  const run = async (action: EdAction): Promise<void> => {
    try {
      const answer = await api.pageAct(plugin, { tool: action.tool, args: action.args });
      setGone(answer.approvalId ? { text: 'Waiting for your approval.' } : { text: action.done, ...(action.undo ? { undo: action.undo } : {}) });
    } catch (error) {
      setGone({ text: error instanceof Error && error.message ? `That did not work: ${error.message}` : 'That did not work.' });
    }
  };
  const undo = async (held: NonNullable<Gone['undo']>): Promise<void> => {
    try {
      await api.pageAct(plugin, { tool: held.tool, args: held.args });
      setGone(null);
    } catch {
      setGone({ text: 'Could not take it back.' });
    }
  };

  if (gone) {
    return (
      <li className="ed-story ed-story-gone" role="status">
        <span>{gone.text}</span>
        {gone.undo ? (
          <>
            <span className="pl-story-gone-sep" aria-hidden="true">·</span>
            <Button size="sm" variant="ghost" onClick={() => void undo(gone.undo!)}>{gone.undo.label}</Button>
          </>
        ) : null}
      </li>
    );
  }

  const words = [s.topicName, outlet ? (s.more > 0 ? `${outlet} and ${s.more} more` : outlet) : ''].filter(Boolean).join(' · ');
  return (
    <li className="ed-story">
      {actions.length > 0 ? (
        <span className="ed-more-btn">
          <ActionMenu label={`Ways out for ${s.title}`} items={menuItems(actions, (action) => (action.confirm ? setAsking(action) : void run(action)))} sheet={{ title: s.title, sub: words }} stacked />
        </span>
      ) : null}
      {asking ? (
        <Modal
          title={asking.confirm ?? asking.label}
          onClose={() => setAsking(null)}
          foot={
            <>
              <Button variant="ghost" onClick={() => setAsking(null)}>Cancel</Button>
              <Button variant="accent" onClick={() => { const chosen = asking; setAsking(null); void run(chosen); }}>{asking.label}</Button>
            </>
          }
        />
      ) : null}
      <AssetImage src={first.logo ? assetSrc(plugin, first.logo) : null} label={first.name} className="pl-logo-md" />
      <span className="ed-story-text">
        <span className="ed-story-title">
          {s.mark ? <span className="ed-mark" data-kind={s.mark === 'update' ? 'update' : undefined}>{s.mark === 'update' ? 'Update' : 'Opinion'}</span> : null}
          {s.title}
        </span>
        {s.lead ? <span className="ed-story-line">{s.lead}</span> : null}
        {outlet ? (
          <span className="ed-story-src">
            {s.link ? (
              <a className="wb-src-link" href={s.link.url} target="_blank" rel="noopener noreferrer" title={s.link.label}>
                {outlet}<span className="wb-src-out" aria-hidden="true">↗</span>
              </a>
            ) : <span>{outlet}</span>}
            {s.more > 0 ? <span className="ed-more">and {s.more} more</span> : null}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** The waveform's bars: fixed heights, the kit's own shape; a picture of a voice, not of this one. */
const BARS = Array.from({ length: 64 }, (_, i) => 30 + Math.round(Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.4)) * 70));

/** A recording, as the kit's pill: play, the waveform filling as it plays, the time, seeking and an MP3 download. */
export function EditionAudio({ audio }: { audio: NonNullable<ReportView['audio']> }): JSX.Element {
  const { playing, loading, failed, position, duration, toggle, seek, bind } = useAudioPlayer(audio.fileId, audio.mime, true);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const done = duration ? Math.min(1, position / duration) : 0;
  return <div>
    <div className="ed-audio" data-testid="edition-audio">
      <button type="button" className="ed-play ui-icon-btn" aria-label={playing ? 'Pause the recording' : 'Play the recording'} aria-pressed={playing} disabled={loading} onClick={() => void toggle()}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <span className="ed-seek">
        <span className="ed-wave" aria-hidden="true">{BARS.map((h, i) => <i key={i} style={{ ['--h' as string]: `${h}%` }} data-on={i < Math.round(done * BARS.length) ? 'true' : undefined} />)}</span>
        <input type="range" aria-label="Playback position" aria-valuetext={`${clock(position)} of ${clock(duration)}`} min={0} max={duration ?? 0} step={0.1} value={position} disabled={!duration} onChange={e => seek(Number(e.target.value))} />
      </span>
      <span className="ed-dur" role="status">{failed ? 'Could not play' : loading ? 'Loading…' : `${clock(position)} / ${clock(duration)}`}</span>
      <button className="ui-icon-btn" type="button" aria-label="Download as MP3" title="Download MP3" disabled={downloading} onClick={() => {
        setDownloading(true); setDownloadError(false);
        void downloadMp3(audio).catch(() => setDownloadError(true)).finally(() => setDownloading(false));
      }}><Icon name="download" size={16} /></button>
      <audio {...bind} />
    </div>
    {downloading ? <p className="muted" role="status">Preparing MP3…</p> : null}
    {downloadError ? <p role="alert">Could not create MP3. <a href={downloadUrl(audio.fileId)} download={audio.filename ?? `recording.ogg`}>Download the original audio</a>.</p> : null}
  </div>;
}

/** The recording filed with a saved report, found by the report's page link; polled while it is still being made. */
export function ReportAudio({ link }: { link: string }): JSX.Element | null {
  const [audio, setAudio] = useState<ReportView['audio']>(null);
  useEffect(() => {
    let live = true;
    setAudio(null);
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const result = await api.reportAudio(link);
        if (!live) return;
        setAudio(result.audio);
        if (!result.audio && ++attempts < 24) timer = setTimeout(() => void read(), 5000);
      } catch { /* The text stays readable when its audio is unavailable. */ }
    };
    void read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [link]);
  return audio ? <EditionAudio key={audio.fileId} audio={audio} /> : null;
}

/** A saved audio file by id, as the recording pill; nothing when it is gone or is not audio. */
export function FileAudio({ id }: { id: string }): JSX.Element | null {
  const [audio, setAudio] = useState<ReportView['audio']>(null);
  useEffect(() => {
    let live = true;
    setAudio(null);
    api.libraryEntry(id)
      .then(({ entry }) => { if (live && entry.mime.startsWith('audio/')) setAudio({ fileId: entry.id, mime: entry.mime, filename: entry.filename, sizeBytes: entry.sizeBytes }); })
      .catch(() => { /* A file that is gone draws nothing. */ });
    return () => { live = false; };
  }, [id]);
  return audio ? <EditionAudio key={audio.fileId} audio={audio} /> : null;
}

/** A page link of `plugin`'s own (`#/p/<plugin>/…`), the only report a plugin's data may point a player at. */
export function isOwnPageLink(plugin: string, link: unknown): link is string {
  return typeof link === 'string' && link.length <= 512 && link.startsWith(`#/p/${plugin}/`)
    && /^[a-z][a-z0-9-]{0,39}(?:\?[A-Za-z0-9_.~%=&+-]{0,400})?$/.test(link.slice(`#/p/${plugin}/`.length));
}

/** The card itself, from the query's answer. `audio` sits under the head, as the kit's player does. */
export function EditionCard({ edition, audio, plugin, legacyFoot = false }: { edition: Edition; audio?: ReactNode; plugin: string; legacyFoot?: boolean }): JSX.Element {
  // A plugin's own closing line (1.33); the chat report's older wording only where it has always been.
  const closing = edition.foot ?? (legacyFoot ? `${edition.next ? `Next edition at ${edition.next}. ` : ''}Tell me what to leave out, or mute anything from News.` : '');
  const foot = [...edition.notes, ...(closing ? [closing] : [])];
  return (
    <div className="ed" data-testid="edition-card">
      <div className="ed-head">
        <span className="ed-kicker">{edition.name}</span>
        {edition.when ? <span className="ed-when">{edition.when}</span> : null}
      </div>
      {audio}
      {edition.lede ? <p className="ed-lede">{edition.lede}</p> : null}
      {edition.groups.map((g, i) => (
        <section key={i} className="ed-group">
          {g.topic ? <h4 className="ed-topic">{g.topic}</h4> : null}
          <ul className="ed-list">{g.stories.map((s, j) => <EdStory key={j} s={s} plugin={plugin} />)}</ul>
        </section>
      ))}
      {foot.length > 0 ? <p className="ed-foot">{foot.join(' ')}</p> : null}
    </div>
  );
}

/**
 * A report that links to an edition: the card once the plugin answers, the
 * text while it does not (and whenever the owner asks for it), the link to
 * the edition on the right under both.
 */
export function EditionReport({
  editionId,
  text,
  audio,
  link,
}: {
  editionId: string;
  text: ReactNode;
  audio: ReportView['audio'];
  link: { route: string; label: string };
}): JSX.Element {
  const [edition, setEdition] = useState<Edition | null | undefined>(undefined);
  const [asText, setAsText] = useState(false);
  useEffect(() => {
    let live = true;
    setEdition(undefined);
    api
      .pageQuery(NEWS, EDITION_QUERY, { id: editionId })
      .then((body) => { if (live) setEdition(editionOf(body.data)); })
      .catch(() => { if (live) setEdition(null); });
    return () => { live = false; };
  }, [editionId]);

  const card = edition && !asText;
  return (
    <div className="wb-report ed-report" data-testid="mission-report">
      {card ? (
        <div className="ed-bubble"><EditionCard edition={edition} plugin={NEWS} legacyFoot audio={audio ? <EditionAudio audio={audio} /> : null} /></div>
      ) : edition === undefined ? (
        <div className="ed-bubble" aria-busy="true"><div className="ed ed-loading" /></div>
      ) : (
        <>
          {audio ? <AudioCard artifactId={audio.fileId} name={audio.filename ?? 'Voice note'} mime={audio.mime} sizeBytes={audio.sizeBytes} /> : null}
          {text}
        </>
      )}
      <div className="ed-actions">
        {edition ? (
          <Button size="sm" variant="ghost" aria-pressed={asText} onClick={() => setAsText(!asText)}>
            {asText ? 'Show as card' : 'Show as text'}
          </Button>
        ) : null}
        <ButtonLink className="wb-report-link" size="sm" href={link.route}>{link.label}</ButtonLink>
      </div>
    </div>
  );
}

/**
 * The audio a tool's output lists under `attachments` (host API 1.33): files
 * by id, and recordings of the tool's own plugin's reports by page link.
 */
export function attachedAudio(plugin: string, output: unknown): Array<{ artifact: string } | { report: string }> {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const list = (output as { attachments?: unknown }).attachments;
  if (!Array.isArray(list)) return [];
  const out: Array<{ artifact: string } | { report: string }> = [];
  for (const raw of list.slice(0, 4)) {
    const item = obj(raw);
    if (!item || item['kind'] !== 'audio' || Object.keys(item).length !== 2) continue;
    if (typeof item['artifact'] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item['artifact'])) out.push({ artifact: item['artifact'] });
    else if (isOwnPageLink(plugin, item['report'])) out.push({ report: item['report'] });
  }
  return out;
}
