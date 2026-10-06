/**
 * `tiles` — a row of small cards that wraps: a glyph, a big value, a label and
 * up to two small lines. The days of a forecast, the next meetings.
 *
 * A list, each card an item whose accessible name is the whole card read as
 * one sentence, so a screen reader hears "Tuesday, 64° / 55°, rain, 80%"
 * rather than four stray fragments. When the tool is not set up the one card
 * says so and links to where it can be.
 *
 * A plugin page draws the same cards (`tiles` in docs/plugin-pages.md), laid
 * out by `layout`: `grid` wraps as here, `row` shares the width between all
 * of them, `strip` keeps each narrow and scrolls sideways — and there the
 * label sits on top and the card is centred, as the design kit draws a day or
 * an hour. With `onPick` each card is a button and one of them is chosen.
 */
import type { CSSProperties } from 'react';
import type { Tile, TilesProps } from '../types';
import { Card } from '../../ui';
import { Icon } from '../../ui/Icon';
import { tileGlyph } from '../tileIcons';
import { usePluginPageHref } from '../../pages/pageLinks';
import { MASK, MaskText } from '../../pages/sensitive';

export type TilesLayout = 'grid' | 'row' | 'strip';

export function Tiles({
  props,
  layout,
  selected,
  onPick,
}: {
  props: TilesProps;
  layout?: TilesLayout;
  /** The index of the chosen card, when cards can be picked. */
  selected?: number | null;
  onPick?: (index: number) => void;
}): JSX.Element {
  if (props.tiles.length === 0) return <p className="wb-empty">{props.empty}</p>;
  return (
    <ul
      className="wb-tiles"
      data-notice={props.notice ? 'true' : undefined}
      data-layout={layout && layout !== 'grid' ? layout : undefined}
      style={layout === 'row' ? ({ '--tiles-n': props.tiles.length } as CSSProperties) : undefined}
    >
      {props.tiles.map((tile, index) => (
        <TileCard
          key={`${index}-${tile.label}`}
          tile={tile}
          {...(onPick ? { picked: index === selected, onPick: () => onPick(index) } : {})}
        />
      ))}
    </ul>
  );
}

function TileCard({ tile, picked, onPick }: { tile: Tile; picked?: boolean; onPick?: () => void }): JSX.Element {
  const target = usePluginPageHref(tile.link);
  // A masked value (1.31) is read as "hidden", never as four bullets.
  const summary = [tile.label, tile.value, ...tile.lines]
    .filter((part) => part !== '')
    .map((part) => part.split(MASK).join('hidden'))
    .join(', ');
  const body = (
    <div className="wb-tile-body" aria-hidden="true">
      <span className="wb-tile-icon" data-icon={tile.icon ?? 'dot'}>
        <Icon name={tileGlyph(tile.icon)} size={22} />
      </span>
      {tile.value !== '' ? <span className="wb-tile-value tnum"><MaskText text={tile.value} /></span> : null}
      <span className="wb-tile-label">{tile.label}</span>
      {tile.lines.map((line, index) => (
        <span key={index} className="wb-tile-line"><MaskText text={line} /></span>
      ))}
    </div>
  );
  if (onPick) {
    return (
      <li className="wb-tile">
        <button
          type="button"
          className="ui-card"
          data-tone={picked ? 'accent' : tile.tone === 'neutral' ? undefined : tile.tone}
          data-selected={picked ? 'true' : undefined}
          aria-pressed={picked === true}
          aria-label={summary}
          onClick={onPick}
        >
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="wb-tile">
      <span className="sr-only">{summary}</span>
      <Card tone={tile.tone === 'neutral' ? undefined : tile.tone}>
        {body}
        {target ? <a className="wb-tile-link" href={target.href}>{target.label}</a> : null}
      </Card>
    </li>
  );
}
