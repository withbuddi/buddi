/**
 * The note a rollover leaves at the top of the fresh conversation.
 *
 * When a conversation ends — idle, or grown too long — the next one opens with
 * a short note written from it: where it stopped, what was decided, what is
 * open (and, from a plugin, state such as the branch a workspace is on). The
 * model reads it as context; the page draws it as a closed "Carried over" fold
 * rather than a bubble, because nobody in this thread said it. The owner may
 * read it and delete it, which takes it out of the context of every later turn.
 */
import { useState } from 'react';
import { Button, Details, Toolbar } from '../ui';

export function CarryOverNote({ text, onDelete }: { text: string; onDelete: () => Promise<void> }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="wb-carryover" data-testid="chat-carryover">
      <Details summary="Carried over from the previous conversation">
        <p className="wb-carryover-text">{text}</p>
        <Toolbar align="end">
          {error ? <span className="critical" role="alert">{error}</span> : null}
          <Button
            size="sm"
            variant="danger-ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              onDelete().catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
                setBusy(false);
              });
            }}
          >
            Delete note
          </Button>
        </Toolbar>
      </Details>
    </div>
  );
}
