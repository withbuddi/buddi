import { useEffect, useState } from 'react';
import { api } from '../../api';
import { EditionAudio, EditionCard, SavedEditionAudio, editionOf, type Edition } from '../../chat/EditionCard';
import { Structured } from './Structured';
import { isPlayableAudio } from '../../chat/AudioCard';

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
function Technical({ value }: { value: unknown }): JSX.Element { return <details className="cv-story-details"><summary>Technical details</summary><Structured props={{ value }} /></details>; }
export function AudioView({ props }: { props: { value: unknown } }): JSX.Element {
  const v = record(props.value);
  if (typeof v.id !== 'string' || typeof v.mime !== 'string' || !isPlayableAudio(v.mime)) return <Structured props={props} />;
  return <div><h3>Voice recording</h3><EditionAudio audio={{ fileId: v.id, mime: v.mime, filename: typeof v.name === 'string' ? v.name : null, sizeBytes: typeof v.bytes === 'number' ? v.bytes : null }} /><p className="muted">{[v.voice, v.model].filter(x => typeof x === 'string').join(' · ')}</p><Technical value={v} /></div>;
}
export function EditionView({ props }: { props: { value: unknown } }): JSX.Element {
  const v = record(props.value);
  const id = typeof v.edition === 'string' ? v.edition : '';
  const [edition, setEdition] = useState<Edition | null>(null);
  const [state, setState] = useState('Loading the saved edition…');
  useEffect(() => {
    let live = true;
    setEdition(null); setState('Loading the saved edition…');
    if (id) api.pageQuery('news', 'edition', { id }).then(result => { if (live) { setEdition(editionOf(result.data)); setState('This edition is no longer available.'); } }).catch(() => { if (live) setState('Could not load the saved edition.'); });
    return () => { live = false; };
  }, [id]);
  if (!id) return <Structured props={props} />;
  return <div>{edition ? <EditionCard edition={edition} audio={<SavedEditionAudio editionId={id} />} /> : <p role="status">{state}</p>}<Technical value={v} /></div>;
}
