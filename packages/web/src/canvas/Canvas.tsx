/**
 * The canvas: tabs across the top holding the last few things this
 * conversation produced, one panel below.
 *
 * The tabs exist so that reading an approval does not cost you the chart you
 * were looking at. They are ordered oldest-first, like the conversation, and
 * the newest is selected unless the owner has moved.
 */
import * as Tabs from '@radix-ui/react-tabs';
import type { ApprovalRow } from '../api';
import { RenderView } from './registry';
import type { Renderable } from './types';

export function Canvas({
  renderables,
  activeId,
  onActivate,
  timezone,
  onDecided,
  emptyHint,
}: {
  renderables: Renderable[];
  activeId: string | null;
  onActivate: (id: string) => void;
  timezone: string;
  onDecided?: (action: ApprovalRow) => void;
  emptyHint?: string;
}): JSX.Element {
  if (renderables.length === 0) {
    return (
      <div className="wb-canvas" data-testid="canvas">
        <div className="wb-canvas-tabs" />
        <div className="wb-canvas-body">
          <div className="wb-empty">
            <strong className="text-text">Nothing on the canvas yet.</strong>
            <span>{emptyHint ?? 'Ask for something. Whatever the run looks at will be drawn here.'}</span>
          </div>
        </div>
      </div>
    );
  }

  const active = renderables.some((item) => item.id === activeId)
    ? (activeId as string)
    : (renderables[renderables.length - 1]!.id);

  return (
    <div className="wb-canvas" data-testid="canvas">
      <Tabs.Root value={active} onValueChange={onActivate} className="contents">
        <Tabs.List className="wb-canvas-tabs" aria-label="Canvas">
          {renderables.map((item) => (
            <Tabs.Trigger key={item.id} value={item.id} className="wb-tab" data-tone={item.tone}>
              {item.title}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {renderables.map((item) => (
          <Tabs.Content key={item.id} value={item.id} className="wb-canvas-body">
            <section className="wb-panel">
              <h3 className="wb-panel-title">{item.title}</h3>
              <p className="wb-panel-sub mono">{item.tool}</p>
              <RenderView
                renderer={item.renderer}
                props={item.props}
                timezone={timezone}
                onDecided={onDecided}
              />
            </section>
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  );
}
