/**
 * "Did this message come after that one?", as SQL, for two watchers that
 * answer entirely on the answer.
 *
 * `email.promised-reply` reports a promise only when **nothing outbound
 * followed** it, and `email.unanswered-by-them` needs both "nothing came back
 * after" and "nothing of theirs came before". All three are the same
 * comparison, and getting it wrong in either direction is a finding the owner
 * should not have seen or one he never sees.
 *
 * ## Why it is not one comparison
 *
 * IMAP's INTERNALDATE has **second** resolution. Two messages in one second is
 * ordinary — a reply sent from a phone while the client syncs, a thread the
 * server delivers in a batch — and comparing instants alone leaves those pairs
 * unordered, so each is or is not the other's follower depending on nothing.
 *
 * The obvious tie-break, the row id, is worse than useless here: `messages.id`
 * is `gen_random_uuid()`, which has no chronology in it at all. Ordering by it
 * is ordering by a coin. What *does* carry order is the **UID**, which is
 * assigned by the server in arrival order — but only within one folder, since
 * INBOX and Sent number their messages independently.
 *
 * So, in order:
 *
 *  1. **same folder** — `(instant, uid)`, a total order that means what it
 *     says: the server saw this one second;
 *  2. **different folders, different instants** — the instants;
 *  3. **different folders, same instant, different `fetched_at`** — the order
 *     buddi saw them in. Weak evidence, but evidence;
 *  4. **everything equal** — *undecidable*. A message in INBOX and a message
 *     in Sent bearing the same second are two facts with nothing between them,
 *     and no column in this database can separate them.
 *
 * Case 4 resolves to **"yes, it came after"**, and that choice is the whole
 * reason this file has a name. Every use of this comparison is a *suppression*
 * — something followed, so say nothing — so resolving a tie as "it followed"
 * means the watcher stays quiet about a conversation it cannot read. A watcher
 * that speaks on a coin-flip is a watcher the owner switches off; one that is
 * quiet about an ambiguous second is one he keeps. It is also symmetric and
 * stable: both rows suppress each other, on every tick, for ever, rather than
 * flapping with whatever the random ids happened to be.
 */

/**
 * `a` came after `b`. Both arguments are table aliases already in scope, each
 * of which must expose `internal_date`, `fetched_at`, `folder_id`, `uid`.
 */
export function cameAfter(a: string, b: string): string {
  const at = (t: string) => `coalesce(${t}.internal_date, ${t}.fetched_at)`;
  return `(case
    when ${a}.folder_id = ${b}.folder_id
      then (${at(a)}, ${a}.uid) > (${at(b)}, ${b}.uid)
    when ${at(a)} <> ${at(b)}
      then ${at(a)} > ${at(b)}
    when ${a}.fetched_at <> ${b}.fetched_at
      then ${a}.fetched_at > ${b}.fetched_at
    -- Undecidable: two folders, one second. Resolved as "it followed", which
    -- silences the watcher rather than making it speak on a coin-flip. See
    -- the module note.
    else true
  end)`;
}

/** `a` came before `b`. The same rule, read the other way round. */
export function cameBefore(a: string, b: string): string {
  return cameAfter(b, a);
}
