import { StoryImage, type StoryPicture } from '../../pages/StoryImage';
/** A sourced story: publisher text, linked articles and a chronological timeline. */
import { AssetImage, assetSrc } from '../../pages/AssetImage';
import { Structured } from './Structured';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
function link(value: unknown): string | undefined {
  try { const url = new URL(text(value)); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function stamp(value: unknown, timezone?: string): string {
  const date = new Date(text(value));
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timezone ? { timeZone: timezone } : {}) }).format(date);
}
export function StoryView({ props, timezone }: { props: { value: unknown; plugin?: string }; timezone?: string }): JSX.Element {
  const story = record(props.value);
  if (Array.isArray(story.articles)) return <SearchResults value={story} plugin={props.plugin ?? 'news'} timezone={timezone} />;
  if (!text(story.title)) return <Structured props={{ value: props.value }} />;
  const sources = rows(story.sources);
  const timeline = rows(story.timeline).sort((a, b) => Date.parse(text(a.at)) - Date.parse(text(b.at)));
  const details = Object.fromEntries(['id', 'topicId', 'score', 'status', 'firstSeen', 'updatedAt', 'lastToldAt'].filter(key => story[key] !== undefined).map(key => [key, story[key]]));
  return <article className="pl-story-sheet">
    <header className="pl-story-sheet-lead">
      {text(story.topic) ? <p className="pl-story-sheet-meta">{text(story.topic)}</p> : null}
      <h2 className="pl-story-sheet-title">{text(story.title)}</h2>
      <p className="pl-story-sheet-meta">{text(story.titleOutlet) ? `Headline from ${text(story.titleOutlet)}` : 'Source headline'}</p>
      <StoryImage image={story.image as StoryPicture | undefined} plugin={props.plugin ?? 'news'} />
      {text(story.lead) ? <><p className="pl-story-sheet-summary">{text(story.lead)}</p><p className="pl-story-sheet-meta">{text(story.leadOutlet) ? `Feed excerpt from ${text(story.leadOutlet)}` : 'Feed excerpt'}</p></> : null}
    </header>
    <section className="pl-story-sheet-block"><h3 className="pl-story-sheet-head">Sources</h3>
      {sources.length ? <ul className="cv-story-sources">{sources.map((source, index) => {
        const href = link(source.url);
        return <li key={text(source.id) || index}>
          <AssetImage src={assetSrc(props.plugin ?? '', source.logo)} label={text(source.outlet)} />
          <div>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{text(source.title)} ↗</a> : <span>{text(source.title)}</span>}
          <p className="pl-story-sheet-meta">{[text(source.outlet), source.language === 'en' ? 'English' : source.language === 'fr' ? 'French' : text(source.language), stamp(source.publishedAt, timezone), source.paywall === true ? 'Paywalled' : '', source.opinion === true ? 'Opinion' : ''].filter(Boolean).join(' · ')}</p></div>
        </li>;
      })}</ul> : <p className="muted">No sources in this saved result.</p>}
    </section>
    {timeline.length ? <section className="pl-story-sheet-block"><h3 className="pl-story-sheet-head">Coverage timeline</h3><ol className="cv-story-timeline">{timeline.map((event, index) => <li key={index}><time>{stamp(event.at, timezone)}</time><div>{index === 0 ? <p className="pl-story-sheet-meta">Earliest collected coverage</p> : null}<strong>{text(event.outlet)}</strong><p>{text(event.title)}</p></div></li>)}</ol></section> : null}
    <details className="pl-story-sheet-block"><summary>Technical details</summary><Structured props={{ value: details }} /></details>
  </article>;
}

function SearchResults({ value, plugin, timezone }: { value: Row; plugin: string; timezone?: string }): JSX.Element {
  const articles = rows(value.articles);
  return <section className="cv-news-search">
    <header><h2>Results for “{text(value.query)}”</h2><p className="muted">{articles.length} {articles.length === 1 ? 'article' : 'articles'}</p></header>
    {articles.length ? <ul>{articles.map((article, index) => {
      const href = link(article.url);
      return <li key={text(article.articleId) || index}>
        <StoryImage image={article.image as StoryPicture | undefined} plugin={plugin} compact />
        <div><p className="pl-story-sheet-meta">{[text(article.topic), text(article.outlet), stamp(article.publishedAt, timezone), article.opinion === true ? 'Opinion' : ''].filter(Boolean).join(' · ')}</p>
          <h3>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{text(article.title)} ↗</a> : text(article.title)}</h3>
          {text(article.lead) ? <p>{text(article.lead)}</p> : null}
          {article.image ? <p className="pl-story-sheet-meta">Image: {text(record(article.image).outlet)}</p> : null}
        </div>
      </li>;
    })}</ul> : <p>No matching articles. Try another name or a broader search.</p>}
    <details className="pl-story-sheet-block"><summary>Technical details</summary><Structured props={{ value }} /></details>
  </section>;
}
