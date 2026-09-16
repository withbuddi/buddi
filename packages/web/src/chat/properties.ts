/**
 * The properties panel as a thing on the canvas.
 *
 * **Why a tab and not a dialog.** The canvas is already the surface for "show
 * me something beside the conversation", it already has a tab strip with an
 * overflow, and it already dismisses the way everything else here does. A modal
 * would have brought a focus trap, a scrim over the transcript, and a second
 * idea of what "open" means — for content that is a reference, not a decision.
 * A reference is exactly what you want to keep *next to* the work: read what
 * the agent may do, click back to the answer, click back again.
 *
 * **Its lifetime is not a tool result's.** Three rules follow from that, and
 * they are the whole of this file:
 *
 *  - it does not have to *earn* a tab. That rule exists so a run calling six
 *    tools does not leave six empty panels; this panel is here because the
 *    owner clicked for it, which settles the question of whether they want it.
 *  - it is never `substantial`. The canvas turns to the newest substantial
 *    thing on its own, and a panel that pinned the screen would stop a live run
 *    drawing its chart. Opening it selects it *once*, explicitly; after that
 *    the work wins and the tab waits.
 *  - it belongs to the agent, so it dies when the owner switches agents (done
 *    where the switch is handled) and it survives a new conversation, which is
 *    not a change of subject.
 *
 * The id is derived from the agent so the tab is stable across refreshes and
 * can never collide with a tool-use id.
 */
import type { AgentProfile } from '../api';
import type { Renderable } from '../canvas/types';

/** The tab id for one agent's properties. Stable, and its own namespace. */
export function profileTabId(agentId: string): string {
  return `agent-properties:${agentId}`;
}

/** The canvas entry for a loaded profile. See the rules above. */
export function profileRenderable(profile: AgentProfile): Renderable {
  return {
    id: profileTabId(profile.id),
    // The panel header's second line. An agent's handle is what the owner
    // types at it, which makes it the right identifier to show.
    tool: `@${profile.handle}`,
    title: 'Properties',
    renderer: 'profile',
    props: { profile },
    at: null,
    source: 'profile',
    substantial: false,
  };
}
