---
name: weekly-consolidation
description: The Sunday procedure — reconcile, tidy the ledger's loose ends, prune what memory got wrong, and stay silent unless something contradicts.
provenance: owner
source: mission weekly-consolidation
created: 2026-09-13
---

Once a week, on Sunday, you put the week away. Nobody is at the keyboard and nothing here is a conversation: the default outcome is silence, and silence is a success.

One thing to be honest about first: **you cannot re-read the week's conversations.** There is no tool that replays what was said on Tuesday. What survives the week is what was written down at the time — the ledger, the notes, the preferences — so the procedure works on those, and never pretends to remember more.

## 1. Re-read what you were told
Recall this week's notes and read back the standing preferences. That is the whole record of what the owner told you about themselves; read it before touching anything, because everything below is judged against it.

## 2. Reconcile
Run a reconcile. Pending charges that have posted get superseded by their posted twin, and receipts meet the charges that finally showed up. Never resolve a double by hand and never delete a row: reconciliation is the only mechanism that is allowed to do this.

## 3. List the loose ends
- Stale balances: every cash-flow account whose balance has not been confirmed in a fortnight. Note which, and how old.
- Receipts still unmatched after a week. Note how many and the oldest.
These are facts to carry into the recap, not reasons to wake anyone.

## 4. Prune the memory
Read this week's notes against each other and against the preferences, looking for exactly three things:
- **a contradiction** — two notes that cannot both be true, or a note that contradicts a standing preference;
- **an expiry** — something that was true and has stopped being true (a contract that ended, a trip that happened, a "for now" that has run out);
- **a duplicate** — the same fact recorded twice in different words.
Drop what should go, with a reason stated in the forget itself, so the deletion stays auditable. Never drop a note because it is merely old: age is not wrongness. When two notes contradict and you cannot tell which is right, drop neither — that is the one thing worth speaking about, see step 6.

## 5. Record what the week taught you that is missing
If something durable was established this week and nothing in memory says it — a new recurring charge the owner explained, an account they reclassified, a standing choice they stated — record it now as a note or a preference, in one self-contained sentence. One fact per note. If nothing is missing, record nothing; the point of this step is a complete record, not a full one.

## 6. End
End with `mission.silent`, and give the one-line reason — "reconciled 3, pruned 1, nothing to act on" is a good reason. The single exception is a contradiction you could not resolve yourself: the owner is the only one who can say which of two facts is true, so that, and only that, is worth `mission.report` — one short plain-text message naming the two facts and asking which stands. Stale balances, unmatched receipts and everything else from steps 3 and 5 go in Friday's recap, never in a Sunday interruption.
