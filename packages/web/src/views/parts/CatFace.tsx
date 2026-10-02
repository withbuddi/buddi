/** An agent's face from the catalogue: its Blob (the package's picture) on its accent's soft ground. */
import type { CatalogueAgent } from '../../api';
import { Avatar } from '../../ui';
import { avatarUrl } from './catalogue-words';

export function CatFace({
  entry,
  size,
}: {
  entry: Pick<CatalogueAgent, 'name' | 'title' | 'tools' | 'avatar'>;
  size?: 'sm' | 'lg' | 'xl' | 'xxl';
}): JSX.Element {
  const picture = avatarUrl(entry);
  return (
    <span className="cat-face" data-size={size}>
      <Avatar id={entry.name} name={entry.title} size={size === 'xxl' ? 'xl' : size} face={{ tools: entry.tools, ...(picture ? { picture } : {}) }} />
    </span>
  );
}
