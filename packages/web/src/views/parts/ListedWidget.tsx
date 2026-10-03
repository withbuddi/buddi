/**
 * A listed widget as the market shows it: the frame Home draws, with the
 * plugin's sample body for that size (`preview`, checked by the gateway) and
 * no menu. Browse's Widgets shelf draws one per widget at the size it starts
 * at; a listing's sheet draws one per size it offers. Without a sample for a
 * size, a quiet frame with the plugin's face says so rather than inventing one.
 */
import type { MarketWidgetView, WidgetSize } from '../../api';
import { AppIcon } from '../../ui';
import { WidgetBodyView } from './WidgetBody';

/** "small or medium", "medium only". */
export function widgetSizesWords(sizes: readonly WidgetSize[]): string {
  return sizes.length > 1 ? 'small or medium' : `${sizes[0]} only`;
}

/** The sizes it offers, in Home's order: small, then medium. */
export function widgetSizesInOrder(sizes: readonly WidgetSize[]): WidgetSize[] {
  return (['small', 'medium'] as const).filter((size) => sizes.includes(size));
}

export function ListedWidgetFrame({ widget, size, svg }: { widget: MarketWidgetView; size: WidgetSize; svg?: string | undefined }): JSX.Element {
  const body = widget.preview?.[size];
  return (
    <div
      className="wg-frame"
      data-variant="preview"
      data-size={size}
      data-kind={body?.kind}
      role="img"
      aria-label={`${widget.title}, ${size}: ${body ? 'a preview with sample data' : 'no preview'}`}
    >
      <div className="wg-head">
        <span className="wg-title">{widget.title}</span>
        {body ? <span className="wg-sample">Sample</span> : null}
      </div>
      <div className="wg-body">
        {body ? (
          <WidgetBodyView body={body} size={size} />
        ) : (
          <span className="wg-state">
            <AppIcon svg={svg} />
            <span className="wg-state-sub">No preview from this plugin.</span>
          </span>
        )}
      </div>
    </div>
  );
}
