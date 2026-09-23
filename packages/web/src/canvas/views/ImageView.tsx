/**
 * `image` — a picture from the Files library, named by a tool result.
 *
 * Any plugin whose result names a library file can use it: a descriptor says
 * where the file's id is, and this panel builds the only two URLs it will
 * ever use — the library's own preview and download routes — around it. The
 * id was checked to be a uuid by the resolver and is checked again here,
 * because `canvas.show` can hand this panel props directly.
 *
 * The picture is fit to the panel; a click opens it at full size in the same
 * tab. The name and size come from the library entry, the dimensions from
 * the picture once it has loaded.
 */
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { downloadUrl, formatBytes, previewUrl } from '../../chat/attachments';
import { ButtonLink, Toolbar } from '../../ui';
import { libraryFileId } from '../resolve';
import type { ImageProps } from '../types';

interface Entry {
  filename: string | null;
  sizeBytes: number | null;
}

export function ImageView({ props }: { props: ImageProps }): JSX.Element {
  const id = libraryFileId(props.artifactId);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (id === null) return undefined;
    let live = true;
    setEntry(null);
    setSize(null);
    setBroken(false);
    api
      .libraryEntry(id)
      .then((answer) => {
        if (live) setEntry({ filename: answer.entry.filename, sizeBytes: answer.entry.sizeBytes });
      })
      // The picture still draws without its entry; only the facts go.
      .catch(() => undefined);
    return () => { live = false; };
  }, [id]);

  if (id === null) {
    return <p className="wb-empty">This result names no file in the Files library.</p>;
  }

  const name = props.title ?? entry?.filename ?? 'Image';
  const facts = [
    size ? `${size.width} × ${size.height}` : null,
    entry?.sizeBytes ? formatBytes(entry.sizeBytes) : null,
  ].filter((fact): fact is string => fact !== null);

  return (
    <figure className="wb-image">
      <div className="wb-image-frame">
        {broken ? (
          <p className="wb-empty">This file cannot be shown here. Download it to open it.</p>
        ) : (
          <a href={previewUrl(id)} className="wb-image-link" title="Open at full size">
            <img
              src={previewUrl(id)}
              alt={props.caption ?? name}
              onLoad={(event) => {
                const picture = event.currentTarget;
                if (picture.naturalWidth > 0) setSize({ width: picture.naturalWidth, height: picture.naturalHeight });
              }}
              onError={() => setBroken(true)}
            />
          </a>
        )}
      </div>
      <figcaption className="wb-image-caption">
        <Toolbar>
          <span className="wb-image-name">{name}</span>
          {facts.length > 0 ? <span className="wb-image-facts">{facts.join(' · ')}</span> : null}
          <span className="ui-toolbar-spacer" />
          <ButtonLink size="sm" href={downloadUrl(id)} download={entry?.filename ?? name}>
            Download
          </ButtonLink>
        </Toolbar>
        {props.caption ? <p className="wb-image-note">{props.caption}</p> : null}
      </figcaption>
    </figure>
  );
}
