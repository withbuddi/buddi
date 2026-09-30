/**
 * An agent's `owner.notify` on the canvas: the message as the owner received
 * it, in the envelope layout the approval uses — where it went in the head,
 * the words as the body, the call's details folded.
 */
import { Details, Pill } from '../../ui';
import { deliveredOf, deliveredTone, notifyCall } from '../../chat/notify';

export interface NotifyViewProps {
  input: unknown;
  output: unknown;
  ok: boolean;
}

export function NotifyView({ input, output, ok }: NotifyViewProps): JSX.Element {
  const call = notifyCall(input);
  const delivered = deliveredOf(output) ?? (ok ? 'sent' : 'not sent');
  return (
    <div className="wb-envelope">
      <div className="envelope">
        <dl className="envelope-head">
          <dt>To</dt>
          <dd className="wb-envelope-action">You</dd>
          <dt>Status</dt>
          <dd><Pill tone={deliveredTone(delivered, ok)} dot>{delivered}</Pill></dd>
        </dl>
        <div className="envelope-body">
          <strong>{call.title}</strong>
          {call.text ? `\n\n${call.text}` : null}
        </div>
      </div>
      <Details summary="The call">
        <dl className="ui-kv wb-envelope-fields">
          <dt>Urgency</dt>
          <dd>{call.urgency}</dd>
          {call.link ? (<><dt>Link</dt><dd className="mono">{call.link}</dd></>) : null}
          {call.key ? (<><dt>Key</dt><dd className="mono">{call.key}</dd></>) : null}
        </dl>
      </Details>
    </div>
  );
}
