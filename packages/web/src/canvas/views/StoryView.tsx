/**
 * `story` (host API 1.33): a `StoryRow` — the shape a plugin page's `stories`
 * feed reads — drawn on the canvas, or a list of them. Every word is the
 * row's own: the headline and its attribution, the summary and its
 * attribution, the update, the quiet line, the sources with their lines, the
 * timeline as the plugin wrote it. Images and logos are the tool's own
 * plugin's assets; links out are http(s) only.
 */
import { AssetImage, assetSrc } from '../../pages/AssetImage';
import { StoryImage, type StoryPicture } from '../../pages/StoryImage';
import type { StoryProps } from '../types';
import { Structured } from './Structured';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);

function link(value: unknown): string | undefined {
  try {
    const url = new URL(text(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function picture(value: unknown): StoryPicture | undefined {
  const image = record(value);
  return text(image.key) ? (image as unknown as StoryPicture) : undefined;
}

/** What the row says that the view does not draw: ids and the plugin's own metadata, collapsed. */
const DRAWN = new Set(['kicker', 'title', 'titleAttribution', 'image', 'summary', 'lead', 'summaryAttribution', 'update', 'updateAttribution', 'meta', 'sources', 'timeline', 'url', 'attachments']);
function rest(value: unknown, drawn: ReadonlySet<string>): Row {
  return Object.fromEntries(Object.entries(record(value)).filter(([key]) => !drawn.has(key)));
}

function Technical({ value }: { value: Row }): JSX.Element | null {
  if (Object.keys(value).length === 0) return null;
  return (
    <details className="pl-story-sheet-block">
      <summary>Technical details</summary>
      <Structured props={{ value }} />
    </details>
  );
}

export function StoryView({ props }: { props: StoryProps }): JSX.Element {
  if (props.rows) return <StoryList rows={rows(props.rows)} plugin={props.plugin} value={rest(props.value, new Set([...Object.keys(record(props.value)).filter((key) => record(props.value)[key] === props.rows), 'attachments']))} />;
  const story = record(props.value);
  if (!text(story.title)) return <Structured props={{ value: props.value }} />;
  const summary = text(story.summary) || text(story.lead);
  const sources = rows(story.sources).filter((source) => text(source.title));
  const timeline = rows(story.timeline).filter((step) => text(step.text));
  return (
    <article className="pl-story-sheet">
      <header className="pl-story-sheet-lead">
        {text(story.kicker) ? <p className="pl-story-sheet-meta">{text(story.kicker)}</p> : null}
        <h2 className="pl-story-sheet-title">{text(story.title)}</h2>
        {text(story.titleAttribution) ? <p className="pl-story-sheet-meta">{text(story.titleAttribution)}</p> : null}
        <StoryImage image={picture(story.image)} plugin={props.plugin} />
        {summary ? <p className="pl-story-sheet-summary">{summary}</p> : null}
        {summary && text(story.summaryAttribution) ? <p className="pl-story-sheet-meta">{text(story.summaryAttribution)}</p> : null}
        {text(story.update) ? (
          <div className="pl-story-sheet-update">
            <p>{text(story.update)}</p>
            {text(story.updateAttribution) ? <p className="pl-story-sheet-meta">{text(story.updateAttribution)}</p> : null}
          </div>
        ) : null}
        {text(story.meta) ? <p className="pl-story-sheet-meta">{text(story.meta)}</p> : null}
      </header>
      {sources.length > 0 ? (
        <section className="pl-story-sheet-block">
          <h3 className="pl-story-sheet-head">Sources</h3>
          <ul className="cv-story-sources">
            {sources.map((source, index) => {
              const href = link(source.url);
              return (
                <li key={index}>
                  <AssetImage src={assetSrc(props.plugin, source.logo)} label={text(source.outlet)} />
                  <div>
                    {href ? <a href={href} target="_blank" rel="noopener noreferrer">{text(source.title)} ↗</a> : <span>{text(source.title)}</span>}
                    <p className="pl-story-sheet-meta">{text(source.meta) || text(source.outlet)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {timeline.length > 0 ? (
        <section className="pl-story-sheet-block">
          <h3 className="pl-story-sheet-head">Timeline</h3>
          <ol className="cv-story-timeline">
            {timeline.map((step, index) => (
              <li key={index} data-told={step.told === true || undefined}>
                <time>{text(step.at)}</time>
                <div><p>{text(step.text)}</p></div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <Technical value={rest(props.value, DRAWN)} />
    </article>
  );
}

function StoryList({ rows: list, plugin, value }: { rows: Row[]; plugin: string; value: Row }): JSX.Element {
  const shown = list.filter((row) => text(row.title));
  return (
    <section className="cv-story-list">
      {shown.length > 0 ? (
        <ul>
          {shown.map((row, index) => {
            const href = link(row.url);
            const image = picture(row.image);
            const line = text(row.meta) || text(row.kicker);
            const credit = image ? [image.credit, image.outlet].filter(Boolean).join(' · ') : '';
            return (
              <li key={text(row.id) || index}>
                <StoryImage image={image} plugin={plugin} compact />
                <div>
                  {line ? <p className="pl-story-sheet-meta">{line}</p> : null}
                  <h3>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{text(row.title)} ↗</a> : text(row.title)}</h3>
                  {text(row.lead) || text(row.summary) ? <p>{text(row.lead) || text(row.summary)}</p> : null}
                  {credit ? <p className="pl-story-sheet-meta">{credit}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">Nothing to show.</p>
      )}
      <Technical value={value} />
    </section>
  );
}
