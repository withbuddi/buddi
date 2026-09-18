# Visible browser implementation

> Superseded default: the final **2026-09-18 owner correction: OS-first** section
> records the current implementation. Computer control is now the default;
> the Playwright plan below is retained as the optional mode's history.

Decision record and implementation checklist — 2026-09-18.

## Product contract

The owner can ask an agent, from the dashboard or Telegram, to work on a
website. An agent granted the browser capability drives a **visible browser on
the Buddi host**: navigation, reading, clicking, filling forms and submitting
the requested action. The owner's request is authorization within its stated
scope; ordinary steps do not each generate an approval request.

The browser is a capability, not another agent and not a separate conversational
workflow. Installing it does not silently grant it to every agent. Existing SMTP
and other specialized tools remain available; they do not replace this feature.

The host must be awake with an available desktop session. A request from a phone
does not open a browser on the phone. A browser on a remote/headless server would
need a separate display setup; that is not the first delivery.

## Implementation choice

Use **headed Playwright**, behind a driver interface, for the first browser
implementation. Visible execution does not require OS-wide mouse/keyboard
control. Prefer semantic targets (accessible roles and labels) over coordinates.
This narrows the earlier OS-computer-use-first proposal in `ARCHITECTURE.md`.
Desktop applications and generalized computer vision are later drivers, not
prerequisites for browser delivery.

Launch a dedicated persistent Buddi profile, never the owner's everyday Chrome
profile. The owner signs in there; subsequent sessions can reuse its cookies.
Profile files are sensitive local data and must be excluded from Git, ordinary
artifact exposure, and model inputs. Do not export cookies or passwords as tools.
Do not promise that a website will accept automation or bypass login challenges.

Use provider-neutral custom tools initially. The existing registry and agent
grants already support that path; a vendor-native browser toolset is an optional
adapter, not a reason to duplicate the runtime loop.

References: [Playwright persistent contexts and launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context),
[semantic locators](https://playwright.dev/docs/locators).

## Current state

The browser plugin, headed driver, interactive session authority and dashboard
controls are implemented. Cancellation now persists results for dispatched and
skipped calls before ending a run; dashboard cancellation waits for that cleanup
before the next turn can write into the same transcript. See
[browser.md](browser.md) for installation, permission grants and limits.

Current verification: full workspace build/typecheck; 1,683 tests across core,
runtime, gateway and browser (excluding the opt-in real-browser fixture) passed;
146 dashboard tests passed. Seven opt-in real Chromium integration tests passed
headlessly, including runtime-to-tool booking, explicit duplicate-link refs,
concurrent owned tabs/popups and human takeover/resume while another conversation
continues. The earlier three-test headed smoke test also passed before this
follow-up. Dashboard and paired Telegram provenance have database-backed coverage.
The rebuilt service is running; the browser endpoint reports clean idle state
with an empty sessions list, and all seven owner-requested browser grants remain.
Fresh visual inspection of this follow-up was unavailable: the Browser skill
reported no connected browser. Automated UI tests, including session selection,
scoped controls and narrow-screen canvas behavior, passed. No real appointment,
email, Telegram API or paid model call was used by these tests. Agent grants
remain an owner choice, not an automatic installation step.

## Delivery sequence

### 1. Runtime and authority boundary

- [x] Repair and test cancellation during tool batches, including cancellation
  before dispatch and immediately after an external action completes.
- [x] Stop dispatching dependent calls after a call requires approval or a
  browser action fails; answer skipped calls so provider transcripts stay valid.
- [x] Carry trusted run/request provenance into browser sessions. Neither tool
  arguments nor page content may create or widen owner authorization.
- [x] Define bounded session authorization under the normal agent tool grant:
  task/request identity, agent, conversation, permitted targets/operations,
  deadline, step budget and revocation. Fail closed without the trusted context.
- [x] Enforce deterministic limits in code. Treat interpretation of natural
  language task scope as agent judgment, not a proven security boundary. Ask the
  owner only when a required choice or authority is genuinely missing.

### 2. Browser plugin and host driver

- [x] Add `packages/tools/browser` following the existing plugin contract;
  register it through `packages/gateway/src/agents/catalog.ts` and the workspace
  build/dependency graph. No browser imports in core.
- [x] Implement lazy headed launch, dedicated persistent profile, clean shutdown
  and clear errors when the host display/browser is unavailable.
- [x] Host one shared persistent profile with per-conversation tab capabilities.
  Serialize actions within a conversation; allow different conversations to work
  concurrently. Scope popups, observations, screenshots and controls to ownership.
- [x] Provide bounded tools for open/navigate, observe, click, fill, select,
  keypress, scroll, tab selection and close. No arbitrary JavaScript execution,
  shell access, file uploads or automatic downloads in the first release.
- [x] Return fresh page evidence with each action; reject stale or ambiguous
  targets instead of guessing. Keep page content visibly marked untrusted.
- [x] Handle cancellation, expiry and revocation during in-flight operations;
  do not automatically retry a submission with an uncertain outcome.
- [x] Enforce URL/navigation restrictions, including redirects and popups;
  prevent browser access to Buddi's control surface and local machine services.
  Document the distinction between URL checks and actual network isolation.
- [x] Add bounded screenshots through the artifact/multimodal path where needed;
  do not serialize image bytes as JSON text into every model turn.

### 3. Shared surfaces and dashboard

- [x] Wire dashboard and Telegram runs to the same host-side browser service.
  Separate CLI processes must not accidentally acquire a second controller.
- [x] Add authenticated dashboard endpoints using existing session, origin and
  CSRF checks. Status reads must never start a browser or perform a page action.
- [x] Show controlling agent, task/session, current site, last action, screenshot
  timestamp and clear running/paused/stopped/error states.
- [x] Add **Stop** and explicit human takeover/resume. An agent cannot undo an
  owner stop. Preserve the browser for manual login when it is safe to do so.
- [x] Reuse existing questions for MFA/missing choices; do not collect credentials
  into normal chat transcripts. Remote browser viewing is not remote desktop
  control; any additional remote-login UI needs an explicit design.
- [x] Grant browser tools only as the owner requests (all seven installed agents
  explicitly granted on 2026-09-18). Document setup and
  how to remove the capability or clear the dedicated profile.

### 4. Prove the complete path

- [x] Unit/integration tests: grants, ownership, concurrent calls, stale targets, expiration,
  revocation, cancellation, blocked targets, closed tabs and driver failures.
- [x] Integration tests: real browser against a local fixture booking site in a
  test-only allowed environment. Navigate, fill, submit once and read the receipt.
- [x] Gateway/UI tests: endpoint authentication, CSRF, unavailable driver, live
  status, failure states, screenshot access and stop/takeover behavior.
- [x] Run source/test typechecks, boundary checks and relevant regression suites.
  Use the web package's own Vitest configuration for DOM tests.
- [x] Perform a **headed** host smoke test with permission to launch the GUI.
  Verify both dashboard and Telegram entry paths; use a fixture, not a real
  appointment or outbound email, for automated verification.
- [x] Build and refresh the running service when ready for the owner to try it.
  Clearly distinguish built, tested and actually running versions.

## Completion criterion

From an agent granted browser tools, the owner requests the fixture appointment.
A real window opens on the host, the agent fills and submits the form once, the
dashboard shows what it is doing, and Stop prevents further actions. The agent
reports the site's receipt rather than merely claiming completion. Saved login
state survives a normal restart, and another agent cannot hijack the session.

## Handoff

### Follow-up regressions, 2026-09-18

- Exact observed-element refs handle repeated labels and avoid false stale-page
  failures from unrelated content updates. Failed preconditions return fresh
  evidence without retrying input; repeated targeting failures pause the task.
- Handoff invalidates prior evidence; resume observes the manually chosen page.
- Release clears current errors and action state. Historical error cards are
  explicitly historical; an idle open session is labeled Ready, not Working.
- Distinct agent/conversation sessions share the profile but cannot target one
  another's tabs. Takeover/release are scoped; global Stop persists across restart.
- Local-fixture regressions cover concurrent tabs/popups, releasing one session
  without closing another, manual handoff, changed references, duplicate links,
  password refusal, budgets, cancellation, and global revocation.

No coding-model change is technically required. Keep the first end-to-end path
and its safety boundaries together; this checklist is also the handoff if the
owner later switches models to reduce cost. Update checkboxes with evidence,
not implementation intent. Preserve the existing uncommitted foundation work;
do not reset the worktree or assume the running service includes it.
# 2026-09-18 owner correction: OS-first

The original Playwright delivery above is retained as the optional driver, not
the default. The owner explicitly requested OS screenshot/accessibility/input
control without a browser debugging connection, including native apps.

Implemented: a compiled macOS 14+ Swift helper (AX, ScreenCaptureKit, CGEvent),
native driver, default-computer/optional-Playwright owner settings, allowed-app
selection, permission probe/request UI, one-conversation desktop lock, fresh
window/target evidence, cancellation and release without quitting apps. Existing
browser grants, bounded task authority and chat canvas remain compatible.

Verification of actual native capture and input is **not complete**: the host
permission probe reports Accessibility=false and ScreenRecording=false. The
owner must grant permissions before the Calculator and Wikipedia takeover tests
in [browser.md](browser.md). No live input/capture success is claimed. Existing
Playwright fixture tests do not validate the new OS driver.

Current regression results: full workspace build and typecheck pass, 1,698 backend
tests pass, 148 dashboard tests pass, and the 7 retained Playwright fixture tests
pass. Native unit tests validate the bridge contract, permission gate, scoped
app selection, evidence, cancellation and mode/ownership rules using test doubles.
The compiled Swift helper's non-prompting permission check and refusal path were
also exercised. Fresh visual inspection was unavailable because the Browser
skill reported no connected browser; component tests are not visual acceptance.

---
