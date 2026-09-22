/**
 * Saying no to offers, on the two pages that draw them.
 *
 * An offer used to have one answer — take it — and a week of silence. The
 * installation this was written for had 65 live offers, most of them from
 * conversations that had long since moved on, and a list nobody can finish is
 * a list nobody reads. So: a refusal, per chip, and one for the whole list.
 *
 * "Dismiss all" is two clicks, never one, and the second one is a sentence
 * that names the number: clearing eleven things by accident because a button
 * was where your thumb landed is the kind of loss that makes a page feel
 * untrustworthy. The count comes from what is on screen, so the sentence is
 * about what the owner is looking at.
 */
import { useState } from 'react';
import { api } from '../../api';
import { Button, Notice } from '../../ui';

export function dismissAllSentence(count: number, agentName?: string): string {
  const what = `${count} offer${count === 1 ? '' : 's'}`;
  const whose = agentName ? ` from ${agentName}` : '';
  return `Dismiss ${what}${whose}? They stop appearing everywhere. Nothing runs, and you can still see them under "Dismissed and lapsed" for a week.`;
}

/**
 * The header control: "Dismiss all", then the sentence, then the deed.
 *
 * Renders nothing when there is nothing to dismiss — a page with no offers
 * should not offer to clear them.
 */
export function DismissAll({
  ids,
  agentName,
  onDone,
}: {
  ids: readonly string[];
  agentName?: string | undefined;
  onDone: () => void;
}): JSX.Element | null {
  const count = ids.length;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  if (count <= 0) return null;
  if (!asking) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setAsking(true)}>
        Dismiss all
      </Button>
    );
  }
  return (
    <span className="ui-row">
      <span className="muted">{dismissAllSentence(count, agentName)}</span>
      <Button
        size="sm"
        variant="danger"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api
            .dismissOffers(ids)
            .then(() => { setAsking(false); onDone(); })
            .finally(() => setBusy(false));
        }}
      >
        {`Dismiss ${count}`}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
        Keep them
      </Button>
    </span>
  );
}
