/**
 * A widget's body, drawn from the six kinds (stat, list, strip, progress,
 * text, clocks) the gateway has already checked and cut to size. Shared by Home's
 * frames, the lock screen's compact tiles and the settings sheet's preview.
 */
import { tileGlyph } from '../../canvas/tileIcons';
import type { WidgetBody, WidgetSize } from '../../api';
import { Icon } from '../../ui';
import { Spark } from './HomeGlances';
import { ClocksView } from './WidgetClocks';
import { AssetImage, isAssetSrc } from '../../pages/AssetImage';

/** Rows a list draws, and tiles a strip draws, by size. */
const ROWS = 3;
const TILES: Record<WidgetSize, number> = { small: 4, medium: 6 };

function Glyph({ icon, size }: { icon?: string | undefined; size: number }): JSX.Element | null {
  return icon ? <span className="wg-icon"><Icon name={tileGlyph(icon)} size={size} /></span> : null;
}

export function WidgetBodyView({ body, size }: { body: WidgetBody; size: WidgetSize }): JSX.Element {
  switch (body.kind) {
    case 'stat':
      return (
        <>
          <span className="wg-stat-now"><Glyph icon={body.icon} size={24} /><span className="wg-value">{body.value}</span></span>
          {body.caption ? <span className="wg-caption">{body.caption}</span> : null}
          <span className="wg-push" />
          {body.trend ? (
            <span className="wg-trend">
              <Spark points={body.trend.points} className="wg-spark" />
              {body.trend.label ? <span>{body.trend.label}</span> : null}
            </span>
          ) : null}
          {body.foot ? <span className="wg-foot">{body.foot}</span> : null}
        </>
      );
    case 'list':
      return (
        <>
          <ul className="wg-list">
            {body.rows.slice(0, ROWS).map((row, i) => (
              <li key={`${row.title}-${i}`} className="wg-row" data-marked={row.image && size === 'medium' ? 'true' : undefined}>
                {/* A plugin's kept image leads the row on medium (1.27): buddi's own path, never a host. */}
                {row.image && size === 'medium' ? <AssetImage className="wg-mark" src={isAssetSrc(row.image.src) ? row.image.src : null} label={row.title} /> : null}
                <span className="wg-row-text">
                  <span className="wg-row-title">{row.title}</span>
                  {row.sub && size === 'medium' ? <span className="wg-row-sub">{row.sub}</span> : null}
                </span>
                {row.side ? <span className="wg-row-side" data-tone={row.tone}>{row.side}</span> : null}
              </li>
            ))}
          </ul>
          <span className="wg-push" />
          {body.more ? <span className="wg-foot">{body.more}</span> : null}
        </>
      );
    case 'strip':
      return (
        <>
          <span className="wg-strip-head">
            <Glyph icon={body.icon} size={20} />
            {body.value ? <span className="wg-strip-value">{body.value}</span> : null}
            {body.caption ? <span className="wg-caption">{body.caption}</span> : null}
          </span>
          <span className="wg-push" />
          <span className="wg-strip">
            {body.items.slice(0, TILES[size]).map((item, i) => (
              <span key={`${item.label}-${i}`} className="wg-tile">
                <span className="wg-tile-label">{item.label}</span>
                <Glyph icon={item.icon} size={18} />
                <span className="wg-tile-value">{item.value}</span>
              </span>
            ))}
          </span>
        </>
      );
    case 'progress': {
      const percent = Math.round(Math.max(0, Math.min(1, body.ratio)) * 100);
      return (
        <>
          <span className="wg-value">{body.value}</span>
          {body.caption ? <span className="wg-caption">{body.caption}</span> : null}
          <span className="wg-push" />
          <span className="ui-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={body.caption ?? body.value}>
            <span className="ui-meter-fill" data-tone={body.tone} style={{ inlineSize: `${percent}%` }} />
          </span>
          {body.foot ? <span className="wg-foot">{body.foot}</span> : null}
        </>
      );
    }
    case 'clocks':
      return <ClocksView body={body} size={size} />;
    case 'text':
      return (
        <span className="wg-text">
          {body.icon ? <span className="wg-text-icon"><Icon name={tileGlyph(body.icon)} size={18} /></span> : null}
          <span className="wg-text-words">
            <span className="wg-text-main">{body.text}</span>
            {body.sub ? <span className="wg-row-sub">{body.sub}</span> : null}
          </span>
        </span>
      );
  }
}

