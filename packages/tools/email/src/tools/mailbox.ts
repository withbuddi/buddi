/**
 * The mailbox tools: select, then mark, archive, move, trash — and undo.
 *
 * The shape an agent is meant to follow is in every description: select the
 * messages (`email.select_messages`, a read), tell the owner how many and
 * show a few, then make the one gated call for all of them. The card says the
 * count, the mailbox, the first five and the criteria; one approval covers up
 * to `MAX_PER_CALL` messages.
 *
 * Tiers: marking, archiving, moving and undoing are gated and may be
 * remembered ("Always"), because each is put back by `email.undo`. Trash is
 * gated and asked every time: Trash is emptied by the provider on its own
 * schedule, and after that there is nothing to undo.
 */
import type { EffectDescription, ToolContext, ToolDefinition } from '@buddi/core/plugin';
import { z } from 'zod';
import { listAccounts } from '../config.js';
import {
  describeUndo,
  destinationFor,
  findAction,
  lastUndoable,
  MailboxRefusal,
  MAX_PER_CALL,
  movedSince,
  performAction,
  plural,
  requireTargets,
  sampleLines,
  serverFacts,
  undoAction,
  undoableItems,
  undoRefusal,
  verbOf,
  withWriter,
  type ActionOutcome,
  type ActionRecord,
  type MailboxActionKind,
  type Provenance,
  type WriterOptions,
} from '../mailbox/actions.js';
import { selectMessages } from '../mailbox/select.js';
import { undoLearnedRule } from '../policies/auto.js';
import type { GatedToolDefinition } from '../types.js';
import { ACCOUNT_ARG, accountScope, UUID } from './shared.js';

const IDS = z
  .array(UUID)
  .min(1)
  .max(MAX_PER_CALL)
  .describe(`The message ids, from email.select_messages (or email.list_recent / email.search). One mailbox per call, at most ${MAX_PER_CALL}.`);

const CRITERIA = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('What these messages are, in the words email.select_messages gave back ("messages from news@shop.example older than 7 days in the inbox"). Shown on the approval card.');

/** What the owner approves for one change. The ids are sorted so the same set is the same card. */
export interface MailboxEnvelope {
  kind: MailboxActionKind;
  accountId: string;
  account: string;
  ids: string[];
  destination: string | null;
  criteria: string | null;
}

function provenanceOf(ctx: ToolContext, criteria: string | null): Provenance {
  let runId: string | null = null;
  try {
    runId = ctx.provenance?.().runId ?? null;
  } catch {
    runId = null;
  }
  const agent = ctx.agentId ?? '';
  return {
    origin: agent === 'owner' ? 'owner' : 'agent',
    actor: agent || 'agent',
    runId,
    actionId: ctx.actionId ?? null,
    criteria,
  };
}

/** The card. Count, mailbox, criteria, what happens, the first five. */
export function renderMailboxPreview(input: {
  kind: MailboxActionKind;
  account: string;
  destination: string | null;
  criteria: string | null;
  targets: ReadonlyArray<{ from: string; subject: string }>;
  gmail?: boolean;
}): string {
  const n = plural(input.targets.length, 'message');
  const head: Record<MailboxActionKind, string> = {
    'mark-read': `Mark ${n} as read in ${input.account}.`,
    'mark-unread': `Mark ${n} as unread in ${input.account}.`,
    archive: `Archive ${n} in ${input.account}.`,
    move: `Move ${n} to ${input.destination} in ${input.account}.`,
    trash: `Move ${n} to Trash in ${input.account}.`,
  };
  const what: Record<MailboxActionKind, string> = {
    'mark-read': 'Your mail server marks them read, everywhere you read mail.',
    'mark-unread': 'Your mail server marks them unread, everywhere you read mail.',
    archive: input.gmail
      ? `They leave the inbox (the Inbox label comes off; they stay in ${input.destination} with their other labels). Nothing is deleted.`
      : `They move to ${input.destination}. Nothing is deleted.`,
    move: `They leave the folder they are in for ${input.destination}. Nothing is created and nothing is deleted.`,
    trash: `They move to ${input.destination ?? 'Trash'} — not deleted, but your provider empties Trash on its own schedule (Gmail after 30 days), and after that they cannot come back. Asked every time.`,
  };
  return [
    head[input.kind],
    ...(input.criteria ? [`Which: ${input.criteria}.`] : []),
    what[input.kind],
    'Undo puts them back (email.undo, or Undo under Recent changes on the Mail page).',
    '',
    ...sampleLines(input.targets),
  ].join('\n');
}

function resultOf(outcome: ActionOutcome): Record<string, unknown> {
  return {
    changed: outcome.changed,
    skipped: outcome.skipped,
    change: outcome.action ? { id: outcome.action.id, kind: outcome.action.kind, destination: outcome.action.destination } : null,
    note: outcome.note,
  };
}

interface ActionInput {
  ids: string[];
  criteria?: string | undefined;
  folder?: string | undefined;
}

/**
 * One gated mailbox tool. `describe` resolves the destination against the
 * live server (a read: CAPABILITY and LIST), so an unknown folder or a server
 * with no Archive is refused before anybody is asked.
 */
function mailboxTool<I extends ActionInput>(
  opts: WriterOptions,
  def: {
    name: string;
    description: string;
    input: z.ZodType<I>;
    kind: (input: I) => MailboxActionKind;
    reusable: boolean;
  },
): GatedToolDefinition<I, unknown, MailboxEnvelope> {
  return {
    name: def.name,
    description: def.description,
    tier: 'gated',
    ...(def.reusable ? { reusableApproval: true } : {}),
    sequential: true,
    input: def.input,

    async describe(input, ctx): Promise<EffectDescription & { envelope: MailboxEnvelope }> {
      const db = ctx.buddi!.db;
      const kind = def.kind(input);
      const { account, targets } = await requireTargets(db, input.ids, await listAccounts(db));
      let destination: string | null = null;
      let gmail = false;
      if (kind !== 'mark-read' && kind !== 'mark-unread') {
        await withWriter(ctx, account, opts, async (client) => {
          const facts = await serverFacts(client);
          gmail = facts.gmail;
          destination = destinationFor(facts, kind, account.address, input.folder);
        });
      }
      const criteria = input.criteria?.trim() || null;
      return {
        envelope: {
          kind,
          accountId: account.id,
          account: account.address,
          ids: targets.map((t) => t.id).sort(),
          destination,
          criteria,
        },
        preview: renderMailboxPreview({ kind, account: account.address, destination, criteria, targets, gmail }),
      };
    },

    async execute(input, ctx) {
      const db = ctx.buddi!.db;
      // Exactly what was approved: the envelope's ids and destination.
      const approved = ctx.approvedEffect?.envelope as MailboxEnvelope | undefined;
      const kind = approved?.kind ?? def.kind(input);
      const ids = approved?.ids ?? input.ids;
      const { account, targets } = await requireTargets(db, ids, await listAccounts(db));
      if (approved && approved.accountId !== account.id) throw new MailboxRefusal('The messages are no longer in the mailbox that was approved.');
      const criteria = approved?.criteria ?? (input.criteria?.trim() || null);
      const outcome = await withWriter(ctx, account, opts, (client) =>
        performAction(db, client, {
          account,
          kind,
          targets,
          ...(approved?.destination ? { folder: approved.destination } : input.folder ? { folder: input.folder } : {}),
          provenance: provenanceOf(ctx, criteria),
          now: ctx.buddi!.clock.now(),
        }),
      );
      return resultOf(outcome);
    },
  };
}

const FLOW =
  'Find the messages with email.select_messages first, tell the owner how many and show a few, then make this one call for all of them (up to 500, one mailbox).';

const markInput = z.object({
  ids: IDS,
  state: z.enum(['read', 'unread']).describe("'read' sets the mailbox's read mark; 'unread' clears it."),
  criteria: CRITERIA,
});

const archiveInput = z.object({ ids: IDS, criteria: CRITERIA });
const trashInput = z.object({ ids: IDS, criteria: CRITERIA });
const moveInput = z.object({
  ids: IDS,
  folder: z
    .string()
    .min(1)
    .describe('The folder (or Gmail label) to move them to, by its name. It must already exist: buddi creates nothing, and an unknown name is refused with the list of folders there are.'),
  criteria: CRITERIA,
});

export function createMailboxTools(opts: WriterOptions): ToolDefinition<never, unknown>[] {
  const mark = mailboxTool(opts, {
    name: 'email.mark',
    description:
      `Mark messages read or unread in the owner's mailbox itself — the server's read mark, so every mail app he uses sees it. ${FLOW} Gated; the owner may allow it always. Undo with email.undo.`,
    input: markInput,
    kind: (input) => (input.state === 'read' ? 'mark-read' : 'mark-unread'),
    reusable: true,
  });
  const archive = mailboxTool(opts, {
    name: 'email.archive',
    description:
      `Archive messages in the owner's mailbox: on Gmail they leave the inbox and keep their labels; on other servers they move to the server's Archive folder (refused, with a sentence, when it has none). Nothing is deleted. ${FLOW} Gated; the owner may allow it always. Undo with email.undo.`,
    input: archiveInput,
    kind: () => 'archive',
    reusable: true,
  });
  const move = mailboxTool(opts, {
    name: 'email.move',
    description:
      `Move messages to an existing folder or Gmail label in the owner's mailbox, by its name. buddi creates no folder: an unknown name is refused with the list of the ones there are. ${FLOW} Gated; the owner may allow it always. Undo with email.undo.`,
    input: moveInput,
    kind: () => 'move',
    reusable: true,
  });
  const trash = mailboxTool(opts, {
    name: 'email.trash',
    description:
      `Move messages to the Trash folder of the owner's mailbox. Never a permanent delete — but the provider empties Trash on its own schedule, so it is asked every time and never remembered. Prefer email.archive for anything the owner might want again. ${FLOW} Undo with email.undo while they are still in Trash.`,
    input: trashInput,
    kind: () => 'trash',
    reusable: false,
  });
  return [selectTool, mark, archive, move, trash, createUndoTool(opts)] as unknown as ToolDefinition<never, unknown>[];
}

/* ------------------------------------------------------------------ *
 * Select
 * ------------------------------------------------------------------ */

const selectInput = z.object({
  account: ACCOUNT_ARG.optional(),
  from: z.string().min(1).optional().describe('One sender address, or a domain (shop.example) for everyone there.'),
  olderThanDays: z.number().int().min(0).max(36_500).optional().describe('Only messages that arrived more than this many days ago.'),
  newerThanDays: z.number().int().min(0).max(36_500).optional().describe('Only messages that arrived within this many days.'),
  policy: UUID.optional().describe("The senders a rule from email.list_policies is about (its sender, domain, list or conversation)."),
  unread: z.boolean().optional().describe('true: only unread messages; false: only read ones.'),
  needsReply: z
    .boolean()
    .optional()
    .describe(
      'true: only messages in conversations waiting on the owner (the "Waiting on you" rule); false: only messages in conversations that are not — notifications, newsletters, mail nobody expects an answer to. Use false to keep a cleanup off anything he still has to answer.',
    ),
  folder: z.string().min(1).optional().describe("A folder or Gmail label by name, or 'any'. Default: the inbox."),
  text: z.string().min(2).optional().describe('Words in the subject, the sender or the body.'),
  limit: z.number().int().positive().max(MAX_PER_CALL).optional().describe(`How many ids to return (default and most ${MAX_PER_CALL}). The count is always the whole match.`),
});

export const selectTool: ToolDefinition<z.infer<typeof selectInput>, unknown> = {
  name: 'email.select_messages',
  untrusted: 'mail',
  description:
    "Find the messages a mailbox cleanup would touch, without touching them: by sender or domain, age, a rule's senders, read state, folder and words. Returns how many match, their ids (up to 500), five of them to show the owner, and the criteria in words. Show the owner the count and the sample, then pass the ids and the criteria to email.mark, email.archive, email.move or email.trash — one gated call for all of them.",
  tier: 'auto',
  input: selectInput,
  async execute(input, ctx) {
    const scope = await accountScope(ctx.buddi!.db, input.account);
    const selection = await selectMessages(
      ctx.buddi!.db,
      scope.accounts,
      {
        ...(input.from ? { from: input.from } : {}),
        ...(input.olderThanDays !== undefined ? { olderThanDays: input.olderThanDays } : {}),
        ...(input.newerThanDays !== undefined ? { newerThanDays: input.newerThanDays } : {}),
        ...(input.policy ? { policyId: input.policy } : {}),
        ...(input.unread !== undefined ? { unread: input.unread } : {}),
        ...(input.needsReply !== undefined ? { needsReply: input.needsReply } : {}),
        ...(input.folder ? { folder: input.folder } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
      },
      ctx.buddi!.clock.now(),
    );
    const accounts = new Set(selection.sample.map((m) => m.account));
    return {
      count: selection.count,
      criteria: selection.criteria,
      ids: selection.ids,
      sample: selection.sample,
      truncated: selection.truncated,
      note:
        selection.count === 0
          ? 'Nothing matches; nothing to change.'
          : `${plural(selection.count, 'message')} ${selection.criteria}.` +
            (selection.truncated ? ` One change covers ${MAX_PER_CALL}; the ids are the newest ${MAX_PER_CALL}.` : '') +
            (accounts.size > 1 ? ' They are in more than one mailbox: one change per mailbox.' : '') +
            ' Show the owner the count and the sample before asking for the change.',
    };
  },
};

/* ------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------ */

const undoInput = z.object({
  change: UUID.optional().describe('The change to undo, by the id a mailbox tool or the Recent changes list gave. Leave it out for the most recent one.'),
  account: ACCOUNT_ARG.optional(),
});

export interface UndoEnvelope {
  changeId: string;
  accountId: string;
  kind: string;
  count: number;
}

async function changeFor(ctx: ToolContext, input: z.infer<typeof undoInput>): Promise<ActionRecord> {
  const db = ctx.buddi!.db;
  if (input.change) {
    const found = await findAction(db, input.change);
    if (!found) throw new MailboxRefusal(`There is no mailbox change ${input.change}.`);
    return found;
  }
  const scope = await accountScope(db, input.account);
  const last = await lastUndoable(db, scope.ids);
  if (!last) throw new MailboxRefusal('There is no mailbox change left to undo.');
  return last;
}

export function createUndoTool(opts: WriterOptions): GatedToolDefinition<z.infer<typeof undoInput>, unknown, UndoEnvelope> {
  return {
    name: 'email.undo',
    description:
      'Put back a change buddi made to the owner\'s mailbox: unmark what was marked, move back what was archived, moved or trashed (while it is still in Trash). The most recent change unless you name one. Gated; the owner may allow it always.',
    tier: 'gated',
    reusableApproval: true,
    sequential: true,
    input: undoInput,
    async describe(input, ctx) {
      const change = await changeFor(ctx, input);
      const refusal = undoRefusal(change);
      if (refusal) throw new MailboxRefusal(refusal);
      const account = (await listAccounts(ctx.buddi!.db)).find((a) => a.id === change.accountId);
      if (!account) throw new MailboxRefusal('That change was made in a mailbox that is turned off or no longer here.');
      return {
        envelope: { changeId: change.id, accountId: account.id, kind: change.kind, count: undoableItems(change).length },
        preview: [
          describeUndo(change, account.address, await movedSince(ctx.buddi!.db, change)),
          `The change was made ${change.createdAt ?? ''} by ${change.origin === 'policy' ? `a rule (${change.actor})` : change.actor}.`,
          '',
          ...sampleLines(undoableItems(change)),
        ].join('\n'),
      };
    },
    async execute(input, ctx) {
      const approved = ctx.approvedEffect?.envelope as UndoEnvelope | undefined;
      const change = await changeFor(ctx, approved ? { change: approved.changeId } : input);
      return resultOf(await runUndo(ctx, opts, change, provenanceOf(ctx, null)));
    },
  };
}

/** Undo one change over a fresh connection. Shared by the tool and the Mail page's button. */
export async function runUndo(ctx: ToolContext, opts: WriterOptions, change: ActionRecord, provenance: Provenance): Promise<ActionOutcome> {
  const db = ctx.buddi!.db;
  const refusal = undoRefusal(change);
  if (refusal) throw new MailboxRefusal(refusal);
  const account = (await listAccounts(db)).find((a) => a.id === change.accountId);
  if (!account) throw new MailboxRefusal('That change was made in a mailbox that is turned off or no longer here.');
  return withWriter(ctx, account, opts, (client) =>
    undoAction(db, client, { account, action: change, provenance, now: ctx.buddi!.clock.now() }),
  );
}

/** The Mail page's Undo: the owner's own button, never listed to a model. */
export function createUndoChangeTool(opts: WriterOptions): ToolDefinition<{ id: string }, unknown> {
  const input = z.object({ id: UUID });
  return {
    name: 'email.undo_change',
    description: 'Undo one mailbox change from the Mail page.',
    tier: 'auto',
    ownerOnly: true,
    input,
    async execute(args, ctx) {
      const change = await findAction(ctx.buddi!.db, args.id);
      if (!change) throw new MailboxRefusal('That change is no longer on the list.');
      const outcome = await runUndo(ctx, opts, change, { origin: 'owner', actor: 'owner', criteria: null });
      return resultOf(outcome);
    },
  };
}

/**
 * Undo on the Mail page's Learned list: stop a rule that kept itself, and
 * with `putBack`, also put back what it changed in the mailbox on arrival
 * (each change through the trail, as Recent changes' Undo would). The rule's
 * card becomes the owner's discard, so its kind's track record starts over.
 * The owner's own button, never listed to a model.
 */
export function createUndoLearnedTool(opts: WriterOptions): ToolDefinition<{ id: string; putBack?: boolean | string }, unknown> {
  const input = z.object({ id: UUID, putBack: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional() });
  return {
    name: 'email.undo_learned',
    description: 'Undo a rule that kept itself, from the Mail page.',
    tier: 'auto',
    ownerOnly: true,
    input,
    async execute(args, ctx) {
      const buddi = ctx.buddi!;
      if (!buddi.proposals) throw new MailboxRefusal('This buddi cannot reach its proposals.');
      const now = buddi.clock.now();
      const rule = await undoLearnedRule({ db: buddi.db, proposals: buddi.proposals }, args.id, now);
      if (!rule) throw new MailboxRefusal('That rule is no longer on the list.');
      let putBack = 0;
      const problems: string[] = [];
      if (args.putBack === true || args.putBack === 'true') {
        for (const id of rule.arrivalChanges) {
          const change = await findAction(buddi.db, id);
          if (!change || undoRefusal(change) !== null) continue;
          try {
            const outcome = await runUndo(ctx, opts, change, { origin: 'owner', actor: 'owner', criteria: null });
            putBack += outcome.changed;
          } catch (err) {
            problems.push(err instanceof Error ? err.message : String(err));
          }
        }
      }
      const parts = [`Stopped quieting ${rule.matcher}; their next message is triaged as usual, and the same rule is not learned again for 90 days.`];
      if (putBack > 0) parts.push(`Put back ${plural(putBack, 'message')}.`);
      if (problems.length > 0) parts.push(`Not everything was put back: ${problems[0]}`);
      return { id: rule.id, revoked: true, putBack, note: parts.join(' ') };
    },
  };
}

export { verbOf };
