/**
 * Home's composer: the front desk, one keystroke from the first page.
 *
 * The same composer the chat uses — files, the microphone, Shift+Enter — and
 * a send that opens a new conversation with the default agent, puts the
 * message in it and goes there, so the answer is read where it is written.
 * A send that fails leaves the words in the box and says why. Under it, the
 * last three conversations with the same agent as one row of chips, so one
 * still being answered is a click back.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, chatApi } from '../../api';
import { Composer, type ComposerDraft, type ComposerHandle } from '../../chat/Composer';
import type { ChatAgent, UploadedAttachment } from '../../chat/types';
import { fmtShortRelative, truncate } from '../../format';
import { chatRoute } from '../../routes';
import { ErrorBanner, useAsync } from '../../ui';
import { NARROW_QUERY, useMediaQuery } from '../../useMediaQuery';

/** How many of the front desk's conversations sit under the box. */
export const HOME_RECENT = 3;

/** A chip's title past this many characters ends in an ellipsis. */
const CHIP_TITLE_MAX = 40;

export function HomeAsk({ agent, navigate }: { agent: ChatAgent; navigate: (route: string) => void }): JSX.Element {
  const composer = useRef<ComposerHandle>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const recent = useAsync(() => chatApi.conversations(agent.id, HOME_RECENT), [agent.id], 30_000);

  // A keyboard and room for it: the box is ready to type into. A phone would
  // throw its keyboard over the page the owner came to read.
  const narrow = useMediaQuery(NARROW_QUERY);
  const touch = useMediaQuery('(pointer: coarse)');
  useEffect(() => {
    if (!narrow && !touch) composer.current?.focus();
  }, []);

  const send = (text: string, attachments: UploadedAttachment[]): void => {
    setSending(true);
    setError(null);
    void (async () => {
      try {
        const { conversationId } = await chatApi.startConversation(agent.id);
        const sent = await chatApi.send(agent.id, {
          conversationId,
          text,
          ...(attachments.length > 0 ? { attachmentIds: attachments.map((file) => file.artifactId) } : {}),
        });
        navigate(chatRoute(agent.id, sent.conversationId));
      } catch (err) {
        // The words are the owner's: back in the box, with the reason above it.
        setError(err instanceof ApiError ? err.message : String(err));
        setDraft({ text, at: Date.now() });
        setSending(false);
      }
    })();
  };

  const rows = (recent.data?.conversations ?? []).slice(0, HOME_RECENT);

  return (
    <div className="home-ask">
      {error ? <ErrorBanner message={error} /> : null}
      <Composer
        ref={composer}
        disabled={sending || !agent.available}
        running={false}
        onSend={send}
        onStop={() => {}}
        agentName={agent.name}
        placeholder={`Message ${agent.name}…`}
        draft={draft}
        threadKey={`home.${agent.id}`}
      />
      {rows.length > 0 ? (
        <div className="home-continue">
          <span className="home-continue-label" id={`home-continue-${agent.id}`}>Continue</span>
          <ul className="home-continue-chips" aria-labelledby={`home-continue-${agent.id}`}>
            {rows.map((row) => {
              const route = chatRoute(agent.id, row.id);
              const title = row.opening ?? row.preview ?? 'Untitled conversation';
              const when = fmtShortRelative(row.lastMessageAt ?? row.createdAt ?? row.startedAt ?? null);
              return (
                <li key={row.id}>
                  <a className="home-continue-chip" href={route} title={title} onClick={(event) => { event.preventDefault(); navigate(route); }}>
                    <span className="home-continue-title">{truncate(title, CHIP_TITLE_MAX)}</span>
                    {when ? <span className="home-continue-when">{when}</span> : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
