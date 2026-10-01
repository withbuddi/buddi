/**
 * Which messages a cleanup would touch, before anything touches them.
 *
 * `email.select_messages` is a read over buddi's own rows: criteria in, ids
 * and a count and a sample out. It is what an agent shows the owner ("240
 * newsletters older than a week, here are five") before it asks for the gated
 * change, and the same sentence goes on the approval card as `criteria`.
 */
import type { DbArea } from '@buddi/core/plugin';
import { normalizeAddress, normalizeListId, UNREAD_SQL } from '../mail.js';
import { domainOf } from '../policies/gate.js';
import { findPolicy } from '../policies/store.js';
import { likeNeedle } from '../search.js';
import { MAX_PER_CALL, MailboxRefusal, plural, SAMPLE_SIZE } from './actions.js';

type Db = Pick<DbArea, 'query'>;

export interface SelectCriteria {
  /** An address, or a domain (`shop.example`, `@shop.example`). */
  from?: string;
  /** Only messages that arrived more than this many days ago. */
  olderThanDays?: number;
  /** Only messages that arrived within this many days. */
  newerThanDays?: number;
  /** The senders a policy is about: its sender, domain, list or thread. */
  policyId?: string;
  /** true: unread only; false: read only. */
  unread?: boolean;
  /** A folder or Gmail label by its server name; 'any' for every folder. Default: the inbox. */
  folder?: string;
  /** Words in the subject, the sender or the body. */
  text?: string;
  /** How many ids to hand back (most `MAX_PER_CALL`). The count is always the whole match. */
  limit?: number;
}

export interface SelectedMessage {
  id: string;
  account: string;
  folder: string;
  from: string;
  subject: string;
  date: string | null;
  unread: boolean;
}

export interface Selection {
  count: number;
  ids: string[];
  sample: SelectedMessage[];
  criteria: string;
  /** True when `count` is more than one call may change. */
  truncated: boolean;
}

/** The criteria in words, for the agent to repeat and the card to show. */
export function criteriaWords(c: SelectCriteria, policyWords?: string): string {
  const parts: string[] = [];
  if (c.unread === true) parts.push('unread');
  if (c.unread === false) parts.push('read');
  parts.push('messages');
  if (c.from) parts.push(`from ${c.from.trim()}`);
  if (policyWords) parts.push(`covered by the rule on ${policyWords}`);
  if (c.text) parts.push(`mentioning "${c.text.trim()}"`);
  if (c.olderThanDays !== undefined) parts.push(`older than ${plural(c.olderThanDays, 'day')}`);
  if (c.newerThanDays !== undefined) parts.push(`from the last ${plural(c.newerThanDays, 'day')}`);
  const folder = c.folder?.trim();
  parts.push(!folder ? 'in the inbox' : folder.toLowerCase() === 'any' ? 'in any folder' : `in ${folder}`);
  return parts.join(' ');
}

export async function selectMessages(
  db: Db,
  accounts: ReadonlyArray<{ id: string; address: string }>,
  c: SelectCriteria,
  now: Date,
): Promise<Selection> {
  const params: unknown[] = [accounts.map((a) => a.id)];
  const where = ['m.account_id = any($1::uuid[])'];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  // A message the poll saw leave in another app, place unknown, is nowhere
  // buddi could change it: never selected, whatever the folder asked.
  where.push('m.gone_at is null');
  const folder = c.folder?.trim();
  if (!folder) where.push(`f.kind = 'inbox'`);
  else if (folder.toLowerCase() !== 'any') {
    // A folder by name, or on Gmail a label the message carries (one
    // labelled in another app sits in All Mail with that label).
    const name = add(folder);
    where.push(
      `(lower(f.name) = lower(${name}) or exists (select 1 from jsonb_array_elements_text(coalesce(m.labels, '[]'::jsonb)) l where lower(l) = lower(${name})))`,
    );
  }

  if (c.from?.trim()) {
    const raw = c.from.trim();
    if (raw.replace(/^@/, '').includes('@')) {
      where.push(`email.address_of(m.from_addr) = ${add(normalizeAddress(raw))}`);
    } else {
      const domain = raw.replace(/^@/, '').toLowerCase();
      where.push(`(email.address_of(m.from_addr) like ${add(`%@${domain.replace(/([\\%_])/g, '\\$1')}`)})`);
    }
  }

  let policyWords: string | undefined;
  if (c.policyId) {
    const policy = await findPolicy(db, c.policyId);
    if (!policy) throw new MailboxRefusal(`There is no rule ${c.policyId}. email.list_policies lists them.`);
    policyWords = `${policy.scope} ${policy.matcher}`;
    switch (policy.scope) {
      case 'sender':
        where.push(`email.address_of(m.from_addr) = ${add(normalizeAddress(policy.matcher))}`);
        break;
      case 'domain':
        where.push(`email.address_of(m.from_addr) like ${add(`%@${domainOf(`x@${policy.matcher.replace(/^@/, '')}`)}`)}`);
        break;
      case 'list-id':
        where.push(`m.list_id is not null and lower(m.list_id) = lower(${add(normalizeListId(policy.matcher) ?? policy.matcher)})`);
        break;
      case 'thread':
        where.push(`m.thread_id = ${add(policy.matcher)}::uuid`);
        break;
    }
    if (policy.accountId) where.push(`m.account_id = ${add(policy.accountId)}::uuid`);
  }

  if (c.unread === true) where.push(UNREAD_SQL.replace('flags', 'm.flags'));
  if (c.unread === false) where.push(`not (${UNREAD_SQL.replace('flags', 'm.flags')})`);

  const at = `coalesce(m.internal_date, m.date, m.fetched_at)`;
  if (c.olderThanDays !== undefined) {
    where.push(`${at} < ${add(new Date(now.getTime() - c.olderThanDays * 86_400_000))}`);
  }
  if (c.newerThanDays !== undefined) {
    where.push(`${at} >= ${add(new Date(now.getTime() - c.newerThanDays * 86_400_000))}`);
  }

  if (c.text?.trim()) {
    const text = c.text.trim();
    if (text.length < 2) throw new MailboxRefusal('Search text needs at least two characters.');
    const needle = add(likeNeedle(text));
    where.push(`(m.subject ilike ${needle} or m.from_addr ilike ${needle} or m.body_text ilike ${needle})`);
  }

  const limit = Math.min(Math.max(1, Math.trunc(c.limit ?? MAX_PER_CALL)), MAX_PER_CALL);
  const from = `from email.messages m join email.folders f on f.id = m.folder_id where ${where.join(' and ')}`;
  const { rows: counted } = await db.query(`select count(*)::int as n ${from}`, params);
  const count = Number(counted[0]?.n ?? 0);
  const { rows } = await db.query(
    `select m.id, m.account_id, f.name as folder, m.from_addr, m.subject, m.date, m.flags
       ${from}
      order by ${at} desc, m.id desc
      limit ${add(limit)}`,
    params,
  );
  const addressOf = new Map(accounts.map((a) => [a.id, a.address]));
  const all: SelectedMessage[] = rows.map((r: Record<string, any>) => ({
    id: String(r.id),
    account: addressOf.get(String(r.account_id)) ?? '',
    folder: r.folder,
    from: r.from_addr ?? '',
    subject: r.subject ?? '',
    date: r.date instanceof Date ? r.date.toISOString() : (r.date ?? null),
    unread: !(Array.isArray(r.flags) && r.flags.includes('\\Seen')),
  }));
  return {
    count,
    ids: all.map((m) => m.id),
    sample: all.slice(0, SAMPLE_SIZE),
    criteria: criteriaWords(c, policyWords),
    truncated: count > limit,
  };
}
