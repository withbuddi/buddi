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
 * out — Not interested, Mute an outlet, Quiet the topic for a week, Mute the
 * topic — run through the news plugin's owner tools (the same ones the News
 * page's ways call); the story then leaves its sentence and Undo in place.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { AssetImage, assetSrc } from '../pages/AssetImage';
import { ActionMenu, Button, ButtonLink } from '../ui';
import { AudioCard, clock, useAudioPlayer } from './AudioCard';
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
  /** The told story it matched; only such a story has ways out. */
  storyId?: string;
  topicId?: string;
  topicName?: string;
  /** Outlets that can be muted, the named one first (up to four). */
  mutable?: Array<{ id: string; name: string }>;
}

export interface Edition {
  id: string;
  name: string;
  when: string;
  lede: string;
  groups: Array<{ topic: string; stories: EditionStory[] }>;
  notes: string[];
  next?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const id = (v: unknown): string => (typeof v === 'string' && ID.test(v) ? v : '');
const isWeb = (url: string): boolean => /^https?:\/\/[^\s]+$/i.test(url);

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
      const storyId = id(o['storyId']);
      const topicId = id(o['topicId']);
      const topicName = str(o['topicName']).trim();
      const mutable = (Array.isArray(o['mutable']) ? o['mutable'] : []).flatMap((m) => {
        if (m === null || typeof m !== 'object') return [];
        const outletId = id((m as Record<string, unknown>)['id']);
        const name = str((m as Record<string, unknown>)['name']).trim();
        return outletId && name ? [{ id: outletId, name }] : [];
      }).slice(0, 4);
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
        ...(storyId ? { storyId } : {}),
        ...(storyId && topicId ? { topicId, topicName: topicName || topicId } : {}),
        ...(storyId && mutable.length > 0 ? { mutable } : {}),
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
  };
}

/** One way out: the owner tool it runs, what it says after, and the call that takes it back. */
export interface EdWay {
  label: string;
  hint?: string;
  heading?: string;
  tool: string;
  args: Record<string, unknown>;
  done: string;
  undo: Record<string, unknown>;
}

/** "Back on its own next Saturday": a week from now, by its weekday. */
function weekHint(now: Date): string {
  const at = new Date(now.getTime() + 7 * 86_400_000);
  return `Back on its own next ${new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(at)}`;
}

/** The kit's ways out for a story the edition told, in its order; none for a story it did not match. */
export function edWays(s: EditionStory, now: Date = new Date()): EdWay[] {
  if (!s.storyId) return [];
  const ways: EdWay[] = [{
    label: 'Not interested', hint: 'Hides it and shows fewer like it', tool: 'news.hide_story',
    args: { id: s.storyId, action: 'not_interested' }, done: 'Hidden. It won’t come back.', undo: { id: s.storyId, action: 'undo' },
  }];
  for (const o of s.mutable ?? []) {
    ways.push({
      label: `Mute ${o.name}`, heading: 'Mute an outlet', tool: 'news.mute_outlet',
      args: { outlet: o.id, muted: true }, done: `Muted ${o.name}. Its stories are hidden.`, undo: { outlet: o.id, muted: false },
    });
  }
  if (s.topicId) {
    const t = s.topicName ?? s.topicId;
    ways.push({
      label: `Quiet ${t} for a week`, hint: weekHint(now), tool: 'news.set_topic',
      args: { topic: s.topicId, mutedForHours: 168 }, done: `${t} is quiet for a week.`, undo: { topic: s.topicId, mutedForHours: 0 },
    });
    ways.push({
      label: `Mute ${t}`, hint: 'Undo it in Sources', tool: 'news.set_topic',
      args: { topic: s.topicId, muted: true }, done: `Muted ${t}. Anchor leaves it out too.`, undo: { topic: s.topicId, muted: false },
    });
  }
  return ways;
}

/** The menu's items: Not interested · Mute an outlet · Quiet and Mute, hairlines between the groups. */
function menuItems(ways: EdWay[], onPick: (way: EdWay) => void): Array<{ label: string; hint?: string; onSelect: () => void } | { heading: string } | 'separator'> {
  const items: Array<{ label: string; hint?: string; onSelect: () => void } | { heading: string } | 'separator'> = [];
  let group: string | undefined | null = null;
  ways.forEach((way, i) => {
    const g = way.heading ?? (way.tool === 'news.set_topic' ? 'topic' : way.tool);
    if (i > 0 && g !== group) items.push('separator');
    if (way.heading && g !== group) items.push({ heading: way.heading });
    group = g;
    items.push({ label: way.label, ...(way.hint ? { hint: way.hint } : {}), onSelect: () => onPick(way) });
  });
  return items;
}

/** What a picked way left in the story's place. */
interface Gone { text: string; undo?: { tool: string; args: Record<string, unknown> } }

function EdStory({ s }: { s: EditionStory }): JSX.Element {
  const [gone, setGone] = useState<Gone | null>(null);
  const first = s.logos[0] ?? { name: s.outlet || s.title };
  const outlet = s.outlet || first.name;
  const ways = edWays(s);

  const pick = async (way: EdWay): Promise<void> => {
    try {
      const answer = await api.pageAct(NEWS, { tool: way.tool, args: way.args });
      setGone(answer.approvalId ? { text: 'Waiting for your approval.' } : { text: way.done, undo: { tool: way.tool, args: way.undo } });
    } catch (error) {
      setGone({ text: error instanceof Error && error.message ? `That did not work: ${error.message}` : 'That did not work.' });
    }
  };
  const undo = async (held: NonNullable<Gone['undo']>): Promise<void> => {
    try {
      await api.pageAct(NEWS, { tool: held.tool, args: held.args });
      setGone(null);
    } catch {
      setGone({ text: 'Could not take it back. Undo it in News → Sources.' });
    }
  };

  if (gone) {
    return (
      <li className="ed-story ed-story-gone" role="status">
        <span>{gone.text}</span>
        {gone.undo ? (
          <>
            <span className="pl-story-gone-sep" aria-hidden="true">·</span>
            <Button size="sm" variant="ghost" onClick={() => void undo(gone.undo!)}>Undo</Button>
          </>
        ) : null}
      </li>
    );
  }

  const words = [s.topicName, outlet ? (s.more > 0 ? `${outlet} and ${s.more} more` : outlet) : ''].filter(Boolean).join(' · ');
  return (
    <li className="ed-story">
      {ways.length > 0 ? (
        <span className="ed-more-btn">
          <ActionMenu label={`Ways out for ${s.title}`} items={menuItems(ways, (way) => void pick(way))} sheet={{ title: s.title, sub: words }} stacked />
        </span>
      ) : null}
      <AssetImage src={first.logo ? assetSrc(NEWS, first.logo) : null} label={first.name} className="pl-logo-md" />
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

/** The edition read aloud, as the kit's pill: play, the waveform filling as it plays, the time. */
export function EditionAudio({ audio }: { audio: NonNullable<ReportView['audio']> }): JSX.Element {
  const { playing, loading, failed, position, duration, toggle, bind } = useAudioPlayer(audio.fileId, audio.mime);
  const done = duration ? Math.min(1, position / duration) : 0;
  const time = failed ? 'Could not play' : loading ? 'Loading…' : duration === null ? 'Listen' : playing || position > 0 ? `${clock(position)} / ${clock(duration)}` : clock(duration);
  return (
    <button type="button" className="ed-audio" aria-label={playing ? 'Pause the edition' : 'Listen to the edition'} aria-pressed={playing} disabled={loading} onClick={() => void toggle()} data-testid="edition-audio">
      <span className="ed-play" aria-hidden="true">
        {playing ? (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="1" /><rect x="9" y="3" width="3" height="10" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M5 3.2v9.6c0 .5.5.8.9.5l7.2-4.8a.6.6 0 0 0 0-1L5.9 2.7c-.4-.3-.9 0-.9.5Z" /></svg>
        )}
      </span>
      <span className="ed-wave" aria-hidden="true">
        {BARS.map((h, i) => <i key={i} style={{ ['--h' as string]: `${h}%` }} data-on={(playing || position > 0) && i < Math.round(done * BARS.length) ? 'true' : undefined} />)}
      </span>
      <span className="ed-dur">{time}</span>
      <audio {...bind} />
    </button>
  );
}

/** The card itself, from the query's answer. `audio` sits under the head, as the kit's player does. */
export function EditionCard({ edition, audio }: { edition: Edition; audio?: ReactNode }): JSX.Element {
  const foot = [
    ...edition.notes,
    `${edition.next ? `Next edition at ${edition.next}. ` : ''}Tell me what to leave out, or mute anything from News.`,
  ];
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
          <ul className="ed-list">{g.stories.map((s, j) => <EdStory key={j} s={s} />)}</ul>
        </section>
      ))}
      <p className="ed-foot">{foot.join(' ')}</p>
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
        <div className="ed-bubble"><EditionCard edition={edition} audio={audio ? <EditionAudio audio={audio} /> : null} /></div>
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
