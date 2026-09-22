/**
 * The policy gate: what happens to a message before anybody is woken.
 *
 * docs/email.md §5. This file is the *decision* and nothing else — a pure
 * function over the policy rows and one message header, with no database, no
 * clock and no model. That split is deliberate: the gate is the thing that
 * decides a message is not worth a run, and a decision nobody can test without
 * a mailbox is a decision nobody will test.
 *
 * Precedence is specificity, in one order, always: **thread, sender, list-id,
 * domain**. A thread the owner muted beats a sender rule; a sender rule beats
 * the newsletter's list; the list beats the domain it arrived from. Within one
 * scope the newest live policy wins, because the later decision is the one the
 * owner made most recently.
 *
 * What the gate never does:
 *
 *  - It never reads a *proposed* policy. Everything learned is a proposal on
 *    the settings page until the owner keeps it — promo included. Nothing
 *    learned applies itself while the Sent folder is unsynced (docs/email.md
 *    §3): "never replied" cannot be known from mail buddi has not read.
 *  - It never reads a revoked one. Revocation keeps the row as a record; it
 *    does not keep its effect.
 *  - It never trusts the message. A From header is forged as easily as it is
 *    read. A policy is the *owner's* standing instruction about a string, and
 *    the worst a forged header can do is claim a rule that starts the run it
 *    would have had anyway — never one that stops it. Which is the rule below:
 *  - **A thread or list-id match never silences a message on its own.**
 *    `threadKey` comes from `References`/`In-Reply-To` and `List-Id` is copied
 *    off the wire, so both are strings the sender chooses. An `ignore` on
 *    either applies only when the sender is corroborated — see
 *    `ignoreIsCorroborated`.
 *
 * And one that is not about trust but about identity: a `sender` policy matches
 * the **normalised exact address**. `mailboxKey` is not used here; it collapses
 * `+tags` for every domain and exists to answer "is this the owner?".
 */
import { normalizeAddress, normalizeListId } from '../mail.js';

export const POLICY_SCOPES = ['thread', 'sender', 'list-id', 'domain'] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

export const POLICY_ACTIONS = [
  'ignore',
  'archive',
  'label',
  'notify',
  'draft',
  'hand-to-agent',
  'wake',
] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const POLICY_ORIGINS = ['owner', 'learned', 'plugin'] as const;
export type PolicyOrigin = (typeof POLICY_ORIGINS)[number];

/**
 * Actions that need an IMAP write this client does not have.
 *
 * `ImapClient` is a peek-only port by construction (`ports.ts`): reading mail
 * must not mutate it, and nothing in this build can set a flag or move a
 * message. So `archive` and `label` are part of the vocabulary — they are what
 * the owner will want, and refusing to *name* them would be a worse lie than
 * refusing to perform them — and both are refused at the point a policy is
 * created, with "not yet". Should a row carrying one reach the gate anyway
 * (written by an older build, or by hand), the gate refuses it and falls
 * through to a run rather than silently dropping the message.
 */
export const UNIMPLEMENTED_ACTIONS: readonly PolicyAction[] = ['archive', 'label'];

export function isUnimplementedAction(action: PolicyAction): boolean {
  return UNIMPLEMENTED_ACTIONS.includes(action);
}

/** Action parameters. Every field optional; each action reads the one it needs. */
export interface PolicyParams {
  /** `label`: the label to apply. Not yet performed. */
  label?: string;
  /** `hand-to-agent`: which agent gets the message. */
  agentId?: string;
  /** `draft`: what the reply should say, in one line. */
  instruction?: string;
  /** `notify`: what the owner is told, in one line. Defaults to the subject. */
  note?: string;
  /** `ignore`: the triage row written from the policy. */
  category?: string;
  urgency?: 'urgent' | 'normal' | 'low';
  /**
   * `thread` and `list-id`: the sender this policy was created about.
   *
   * A thread key and a List-Id are strings the *sender* controls (see the
   * corroboration rule below), so a policy about one carries the address it
   * was created for, and an `ignore` on it fires only for that address.
   */
  sender?: string;
}

export interface PolicyRecord {
  id: string;
  /** Null means every account on this installation. */
  accountId: string | null;
  scope: PolicyScope;
  matcher: string;
  action: PolicyAction;
  params: PolicyParams;
  origin: PolicyOrigin;
  /** A learned suggestion the owner has not kept yet. The gate skips these. */
  proposed: boolean;
  createdFrom: Array<{ messageId: string; processingVersion: number }>;
  createdAt: string | null;
  revokedAt: string | null;
}

/** Everything the gate is allowed to look at. Deliberately not the body. */
export interface MessageHeader {
  /** The conversation key, as `threadKeyFor` derived it. */
  threadKey: string | null;
  /** The From address, in whatever form it arrived. */
  from: string;
  /** The List-Id header, or null when the message carried none. */
  listId?: string | null;
  /** Which account it landed in. Null skips the account check. */
  accountId?: string | null;
}

export interface GateDecision {
  /** The policy that decided, or null when nothing matched. */
  policy: PolicyRecord | null;
  /** What to do: the policy's action, `'none'` when nothing matched. */
  action: PolicyAction | 'none';
  /** True when this build cannot perform the matched action. */
  refused: boolean;
  /** One line, owner-facing, saying what happened and why. */
  detail: string;
}

/** The domain an address belongs to, lowercased. Empty when it has none. */
export function domainOf(raw: string): string {
  const bare = normalizeAddress(raw);
  const at = bare.lastIndexOf('@');
  return at > 0 ? bare.slice(at + 1) : '';
}

/** Does one live policy match this header? Scope decides what is compared. */
export function matches(policy: PolicyRecord, header: MessageHeader): boolean {
  const matcher = policy.matcher.trim().toLowerCase();
  if (matcher === '') return false;
  switch (policy.scope) {
    case 'thread':
      return header.threadKey !== null && header.threadKey.trim().toLowerCase() === matcher;
    case 'sender': {
      // The normalised *exact* address, not `mailboxKey`. That key collapses
      // `+tags` onto the base mailbox for every domain, and plenty of
      // providers treat a plus as an ordinary local-part character: an ignore
      // for `sales@example.test` must not silence the distinct sender
      // `sales+legal@example.test`. `mailboxKey` stays what its own
      // documentation says it is — the answer to "is this the owner?".
      const address = normalizeAddress(header.from);
      return address !== '' && address === normalizeAddress(matcher);
    }
    case 'list-id': {
      const listId = normalizeListId(header.listId ?? null);
      return listId !== null && listId === normalizeListId(matcher);
    }
    case 'domain': {
      const domain = domainOf(header.from);
      return domain !== '' && domain === matcher.replace(/^@/, '');
    }
  }
}

/** Live and applicable: not revoked, not a proposal, and for this account. */
export function isLive(policy: PolicyRecord, accountId?: string | null): boolean {
  if (policy.revokedAt !== null) return false;
  if (policy.proposed) return false;
  if (policy.accountId !== null && accountId != null && policy.accountId !== accountId) return false;
  return true;
}

/** Newest first, for the tie-break within one scope. */
function newerFirst(a: PolicyRecord, b: PolicyRecord): number {
  const at = a.createdAt ? Date.parse(a.createdAt) : 0;
  const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
  if (at !== bt) return bt - at;
  return a.id < b.id ? 1 : -1;
}

/**
 * May this thread or list-id policy silence this message?
 *
 * **A thread or a List-Id match may never produce `ignore` on its own.** Both
 * are matched against headers the sender writes: `References`/`In-Reply-To`
 * decide `threadKey`, and `List-Id` is copied verbatim off the wire. Neither is
 * authenticated, so anyone who learns a muted thread's root id or a public
 * list's id could otherwise address a message into silence — and thread is the
 * *first* scope in the precedence order, so that silence would beat every
 * sender, list and domain rule the owner has.
 *
 * So an `ignore` carried by a `thread` or `list-id` policy applies only when
 * one of two things is also true:
 *
 *  1. the policy records the **sender it was created for** (`params.sender`) —
 *     that is how the owner muting *this* thread or *this* list is stored — and
 *     the message is from that address; or
 *  2. the sender of this message independently matches a live **sender or
 *     domain** policy of the same account, which is the owner (or the learning)
 *     having said something about the address itself.
 *
 * Nothing else changes: `notify`, `draft`, `wake` and `hand-to-agent` all still
 * start a run, so a forged header can at worst ask for the treatment the
 * message would have had anyway. Only the action that *stops* a run is bound to
 * something the sender cannot choose.
 */
function ignoreIsCorroborated(
  policy: PolicyRecord,
  header: MessageHeader,
  live: readonly PolicyRecord[],
): boolean {
  if (policy.scope !== 'thread' && policy.scope !== 'list-id') return true;
  if (policy.action !== 'ignore') return true;
  const recorded = normalizeAddress(policy.params.sender ?? '');
  if (recorded !== '') return recorded === normalizeAddress(header.from);
  return live.some((p) => (p.scope === 'sender' || p.scope === 'domain') && matches(p, header));
}

/**
 * The gate. Pure: the same header and the same rows always decide the same way.
 */
export function applyPolicies(
  header: MessageHeader,
  policies: readonly PolicyRecord[],
): GateDecision {
  const live = policies.filter((p) => isLive(p, header.accountId) && matches(p, header));
  for (const scope of POLICY_SCOPES) {
    const candidates = live
      .filter((p) => p.scope === scope)
      .filter((p) => ignoreIsCorroborated(p, header, live))
      .sort(newerFirst);
    const policy = candidates[0];
    if (!policy) continue;
    if (isUnimplementedAction(policy.action)) {
      return {
        policy,
        action: policy.action,
        refused: true,
        detail:
          `Policy ${policy.scope} ${policy.matcher} asks to ${policy.action} this message, ` +
          'which this build cannot do yet; it was triaged as usual instead.',
      };
    }
    return {
      policy,
      action: policy.action,
      refused: false,
      detail: describeDecision(policy),
    };
  }
  return {
    policy: null,
    action: 'none',
    refused: false,
    detail: 'No policy matched; the message was triaged.',
  };
}

/** One owner-facing line for a decision that was carried out. */
export function describeDecision(policy: PolicyRecord): string {
  const where = `${policy.scope} ${policy.matcher}`;
  switch (policy.action) {
    case 'ignore':
      return `Ignored by policy on ${where}; no run started.`;
    case 'notify':
      return `Policy on ${where} asked for a line to the owner.`;
    case 'hand-to-agent':
      return `Policy on ${where} handed the message to ${policy.params.agentId ?? '(no agent named)'}.`;
    case 'draft':
      return `Policy on ${where} asked for a draft reply.`;
    case 'wake':
      return `Policy on ${where} asked for the usual triage run.`;
    default:
      return `Policy on ${where}: ${policy.action}.`;
  }
}
