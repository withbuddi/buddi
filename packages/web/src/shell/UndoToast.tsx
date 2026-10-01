/**
 * A short note in the corner after something was taken away, with Undo while
 * it can still come back. The page's own toast, beside the notification
 * cards in the same stack; Radix gives it the timer (paused under the
 * pointer and while the window is away), the swipe, and the live region.
 */
import * as Toast from '@radix-ui/react-toast';

/** How long Undo is offered after a group is deleted: well inside the server's minute. */
export const GROUP_UNDO_SHOWN_MS = 10_000;

export function UndoToast({ title, body, duration, onUndo, onGone }: {
  title: string;
  body?: string;
  duration: number;
  /** Absent: a note with nothing to undo. */
  onUndo?: () => void;
  /** It closed: timed out, swiped, dismissed, or Undo was pressed. */
  onGone: () => void;
}): JSX.Element {
  return (
    <Toast.Root className="ui-toast wb-undo-toast" duration={duration} onOpenChange={(open) => { if (!open) onGone(); }} data-testid="undo-toast">
      <span className="ui-toast-mark" aria-hidden="true" />
      <div className="ui-toast-main">
        <Toast.Title className="ui-toast-title">{title}</Toast.Title>
        {body ? <Toast.Description className="ui-toast-body">{body}</Toast.Description> : null}
      </div>
      {onUndo ? (
        <Toast.Action altText="Undo" asChild>
          <button type="button" className="ui-btn wb-undo-toast-action" data-variant="ghost" data-size="sm" onClick={onUndo}>Undo</button>
        </Toast.Action>
      ) : null}
    </Toast.Root>
  );
}
