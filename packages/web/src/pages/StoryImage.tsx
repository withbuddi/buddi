import { useState } from 'react';
import { assetSrc } from './AssetImage';
export interface StoryPicture { key: string; caption?: string; credit?: string; outlet: string; url: string }
export function StoryImage({ image, plugin, compact = false }: { image?: StoryPicture; plugin: string; compact?: boolean }): JSX.Element | null {
  const [failed, setFailed] = useState<string | null>(null);
  const src = image ? assetSrc(plugin, image.key, 768) : null;
  if (!src || failed === src || !image) return null;
  const href = /^https?:\/\//i.test(image.url) ? image.url : undefined;
  return <figure className="pl-story-image" data-compact={compact || undefined}>
    <img src={src} alt={compact ? '' : image.caption || `Image supplied by ${image.outlet}`} loading="lazy" decoding="async" onError={() => setFailed(src)} />
    {!compact ? <figcaption>{image.caption ? <span>{image.caption} </span> : null}{[image.credit, image.outlet].filter(Boolean).join(' · ')}{href ? <> · <a href={href} target="_blank" rel="noopener noreferrer">Source ↗</a></> : null}</figcaption> : null}
  </figure>;
}
