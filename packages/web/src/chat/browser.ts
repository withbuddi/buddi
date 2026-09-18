import type { BrowserStatus } from '../api';
import type { Renderable } from '../canvas/types';

/** Live sessions belong to a conversation, not to whichever chat is visible. */
export function conversationBrowser(
  status: BrowserStatus | undefined,
  agentId: string | null,
  conversationId: string | null,
): Renderable | null {
  const session = status?.session;
  if (!session || !agentId || !conversationId || session.agentId !== agentId || session.conversationId !== conversationId) return null;
  return {
    id: `host-browser:${session.id}`,
    title: status.mode === 'computer' ? 'Computer' : 'Browser', tool: 'Host browser', renderer: 'browser', source: 'browser',
    props: {}, at: null, substantial: false,
  };
}
