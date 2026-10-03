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
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { AssetImage, assetSrc } from '../pages/AssetImage';
import { Button, ButtonLink } from '../ui';
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

function EdStory({ s }: { s: EditionStory }): JSX.Element {
  const first = s.logos[0] ?? { name: s.outlet || s.title };
  const outlet = s.outlet || first.name;
  return (
    <li className="ed-story">
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
