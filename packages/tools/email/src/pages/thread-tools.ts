/**
 * The owner's own word on a conversation, from the Mail page's reading pane.
 *
 * "Needs a reply" is a state the page shows (needs-you.ts); Done is how the
 * owner says it no longer does — he answered elsewhere, or nothing is owed.
 * It closes the conversation, which takes it off "Waiting on you", the
 * widget and the watcher, and new mail from them opens it again: closed is
 * not muted (threads.ts). `ownerOnly`: no model is offered it, because "the
 * owner is done with this" is not an agent's to say.
 */
import type { ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { findThread, setThreadState } from '../threads.js';

const doneInput = z.object({ thread: z.string().uuid() }).strict();

export class ThreadRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadRefusal';
  }
}

export function createThreadDoneTool(): ToolDefinition<z.infer<typeof doneInput>, unknown> {
  return {
    name: 'email.thread_done',
    description:
      'The owner marking a conversation done from the Mail page: it stops waiting on him until they write again.',
    tier: 'auto',
    ownerOnly: true,
    input: doneInput,
    async execute(input, ctx) {
      const thread = await findThread(ctx.buddi!.db, input.thread);
      if (!thread) throw new ThreadRefusal('No conversation here has that id.');
      if (thread.state === 'muted') {
        throw new ThreadRefusal('This conversation is muted, so it is not waiting on you already.');
      }
      await setThreadState(ctx.buddi!.db, thread.id, 'closed');
      return {
        done: true,
        thread: thread.id,
        note: 'Done. It no longer waits on you; a new message from them brings it back.',
      };
    },
  };
}
