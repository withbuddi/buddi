/**
 * `audio` and `query` (host API 1.33). `audio` plays a saved recording the
 * tool returned (`id`, `mime`, optional `name`, `bytes`, `voice`, `model`).
 * `query` asks the tool's own plugin one of its page queries and draws the
 * page components its view declares against the answer — the plugin's
 * screen, in the canvas, with no plugin code in the page.
 */
import { EditionAudio } from '../../chat/EditionCard';
import { isPlayableAudio } from '../../chat/AudioCard';
import { PluginComponents } from '../../pages/PluginPage';
import type { Component } from '../../pages/types';
import type { QueryProps } from '../types';
import { Structured } from './Structured';

const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function Technical({ value }: { value: unknown }): JSX.Element {
  return (
    <details className="cv-story-details">
      <summary>Technical details</summary>
      <Structured props={{ value }} />
    </details>
  );
}

export function AudioView({ props }: { props: { value: unknown } }): JSX.Element {
  const v = record(props.value);
  if (typeof v.id !== 'string' || typeof v.mime !== 'string' || !isPlayableAudio(v.mime)) return <Structured props={props} />;
  const about = [v.voice, v.model].filter((x): x is string => typeof x === 'string' && x !== '').join(' · ');
  return (
    <div>
      <EditionAudio audio={{ fileId: v.id, mime: v.mime, filename: typeof v.name === 'string' ? v.name : null, sizeBytes: typeof v.bytes === 'number' ? v.bytes : null }} />
      {about ? <p className="muted">{about}</p> : null}
      <Technical value={v} />
    </div>
  );
}

export function QueryView({ props, timezone }: { props: QueryProps; timezone?: string }): JSX.Element {
  if (!props.plugin || !props.query || props.body.length === 0) return <Structured props={{ value: props.value }} />;
  return (
    <div>
      <PluginComponents
        plugin={props.plugin}
        query={props.query}
        params={props.params}
        body={props.body as Component[]}
        timezone={timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
      />
      <Technical value={props.value} />
    </div>
  );
}
