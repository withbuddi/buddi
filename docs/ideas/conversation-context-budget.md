# Conversation context budget follows the model, not a fixed cap

Status: Accepted
Captured: 2026-09-21
Built on branch `context-budget` (2026-09-21).

## Problem / opportunity

A conversation is projected to the model under a fixed budget of about 80k
tokens, whatever the model's own window is. A chat that drives the browser or
the computer fills that in a few steps: every observation is a page tree plus
a screenshot, and every `browser.act` result carries both. Once the budget is
spent, earlier turns fall out of the projection and the agent no longer knows
what it was doing: it re-observes, repeats a step, or asks the owner again.

The models we bind have windows between 128k and 1M tokens. A cap set for the
smallest of them wastes most of what the others could hold, and the cost of
the cap lands exactly on the conversations that need history most.

## Possible approach

- Find where the cap lives (`packages/runtime/src/projection.ts` is the
  projection; the number and its rationale are not written next to it) and
  write the rationale down first. If it was chosen for cost or latency rather
  than for a window, say so, because those want a different fix.
- Make the budget a property of the bound model: each provider adapter knows
  the window of the models it serves, or the account records it, and the
  projection takes a fraction of it (leave room for the answer and the
  system context).
- Spend the budget better before spending more of it: tool results that
  carry a screenshot or a page tree are evidence for one step, not for the
  whole conversation. Keep the latest observation whole and reduce earlier
  ones to one line each (URL, title, what was clicked), the way a person
  remembers a browsing session. The transcript keeps everything; only the
  projection shrinks.
- When the projection must drop turns, drop them behind a short written
  summary of what was done so far and what the current task is, rather than
  silently. The agent then keeps its task even after a long session.

## Open questions

- Where exactly is 80k enforced, and is it one place or several (runtime
  projection, gateway run loop, provider adapter)?
- Do the adapters know their models' windows today, or does that need a
  field on the account?
- Is the cap also protecting against cost on metered accounts? Then the
  per-model budget wants an owner setting next to the model choice.
- How much of a browser conversation is screenshots by bytes, and does
  dropping older screenshots alone solve most of it?

## Next decision

Measure one real browser conversation: tokens per step, what share is
observations, and at which step the agent first loses the task. That decides
between raising the budget per model and compacting observations, or both.
Smallest next step: the rationale comment next to the constant, and a log
line when the projection drops turns, so the loss becomes visible.

## Related work

- `packages/runtime/src/projection.ts` (the projection and its truncation of
  large tool results).
- `docs/browser.md`, `docs/computer-use.md` (what an observation holds).

## Follow-up captured 2026-09-21

A browser session ends the conversation (the rollover rule), and what the agent learned in it is lost unless it wrote it down: the Finance Advisor read a live balance from PNC, recorded only the transaction, and the next chat answered from stale ledger balances. Two fixes: the finance plugin instructs the advisor to record an observed balance with set_balance before answering; buddi writes a short handoff of what was learned into the fresh conversation the rollover starts.

## What was built (branch `context-budget`)

The open questions, answered by the code:

- **Where 80k was enforced.** Not in the projection at all: in
  `packages/gateway/src/surfaces/conversation-lifetime.ts`, as
  `MAX_TRANSCRIPT_CHARS`, the *size* axis of the rollover rule. The projection
  has its own cap, but only groups pass one. So a browser conversation was not
  losing its oldest turns — it was **ending**, and the agent started again in a
  fresh transcript. `MAX_TRANSCRIPT_CHARS` is now a floor, and the rationale is
  written next to it.
- **Do the adapters know the windows?** No, and no provider serves them over
  the wire in a usable shape. `packages/runtime/src/context-window.ts` holds
  the table (Claude 5 and 4.x, GPT-5 and the o-series, common local models by
  name prefix; unknown → 128k), with an owner override per **account** in
  `core.provider_accounts.context_window_tokens` — per account, because two
  OpenAI-compatible accounts are two endpoints with two `num_ctx` values under
  the same model names — surfaced as a "Context window" field on the Providers
  page. The limit is **half** the window, counted in tokens: non-ASCII
  characters at one token each, the rest at 3.6 characters a token, since CJK
  tokenises near 1:1 and a character budget would hand it three times the room
  it has. The old 80k constant is the compatibility fallback for an
  installation with no accounts at all — not a floor, since an owner who
  declares an 8k window means it. An agent with no binding is sized against
  the installation's default account.
- **Is the cap protecting cost?** Partly — the runaway that motivated it was a
  mail thread charged 64k tokens a turn — which is why the share is 60% and
  the override sits with the model choice.
- **Is it mostly observations?** Yes. `compactObservations` in
  `packages/runtime/src/projection.ts` reduces every `browser.act` /
  `browser.status` / `computer` result older than the last two **observations**
  to one line (tool, action, title, URL, ok/failed) — results that carry no
  page, a status answer or a failed click, are left alone and do not count,
  so a status call can never evict the page the agent is acting on. The
  transcript on disk keeps them whole, and the rollover now counts the
  **projected** size, cached per version of the transcript so a long browser
  conversation is measured once rather than on every turn.
- **When a conversation does end**, every size rollover carries a note —
  the task, the last thing asked, the agent's last words, the pages if any —
  under the hidden speaker the browser handoff already used
  (`surfaces/browser-handoff.ts`), with URLs stripped of credentials, query and
  fragment, titles labelled as the pages' own untrusted words, and every copied
  message redacted of anything credential-shaped and capped at 400 characters.
  Idle rollovers are unchanged. The rollover itself logs one line with the
  reason, both sizes and the limit applied.
