/**
 * First run — the types.
 *
 * The shape of one row of `core.onboarding` plus the owner's profile, and
 * nothing else: no policy, no copy, no decision about when the conversation
 * happens. A surface reads the state and starts the agent; the agent conducts
 * the interview through the `owner.*` tools and says when it is finished.
 */

/** Where an installation is in its first conversation. */
export type OnboardingState = 'pending' | 'in-progress' | 'done' | 'skipped';

/** Every state, in the order they happen. Mirrors the CHECK in migration 013. */
export const ONBOARDING_STATES: readonly OnboardingState[] = [
  'pending',
  'in-progress',
  'done',
  'skipped',
];

/**
 * The questions the shipped first-run skill asks, as the names it records.
 *
 * Canonical, not enforced: `markStepDone` takes any string, nothing checks the
 * order, and a skill an owner writes may record steps that are not in this
 * list. It exists so that code which *reports* progress — a nudge, a dashboard
 * line, `owner.get_profile` — has one spelling to compare against.
 */
export const ONBOARDING_STEPS = ['name', 'agent-name', 'timezone', 'first-mission'] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * The speaker written on the one turn a surface sends on the owner's behalf.
 *
 * First run has to make the assistant speak first, and the runtime has no turn
 * that nobody asked for: the instruction is sent as a message, and this on its
 * `speaker` column is what tells every transcript reader to leave it out. A
 * colon keeps it out of the space agent handles live in, so it can never be
 * mistaken for a member of a room.
 */
export const OPENING_TURN_SPEAKER = 'first-run:opening';

/**
 * The speaker written on the turn that carries a decided approval's outcome.
 *
 * A run that stopped awaiting an approval resumes with the result delivered
 * late, as a user turn — the API requires it, because the tool_use it belongs
 * to was answered before the run suspended. But the owner did not type "tool
 * result (deferred) for action …: succeeded", and a transcript that draws it
 * as their words is telling them they said something they did not. The same
 * shape as `OPENING_TURN_SPEAKER`, and for the same reason: the model still
 * sees the turn, and the readers know what it is.
 */
export const APPROVAL_RESUME_SPEAKER = 'approval:resume';

/**
 * What first run learned that is not a question: which conversation the owner
 * met their assistant in, and which account they chose while meeting it.
 *
 * Small and deliberately open: it is provenance the page resumes from, never
 * something the runtime branches on.
 */
export interface OnboardingDetails {
  /** The handover conversation, so a reload rejoins it instead of opening one. */
  conversationId?: string;
  /** The account chosen during first run, which is the assistant's brain. */
  accountId?: string;
}

/** One row of `core.onboarding`, or the synthetic pending row before there is one. */
export interface Onboarding {
  ownerId: string;
  state: OnboardingState;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Which surface the conversation happened on. Provenance only. */
  surface: string | null;
  /** Steps the interview got through, in the order they were recorded. */
  stepsDone: string[];
  /** What the steps do not say: which conversation, which account. */
  details: OnboardingDetails;
  /** The first-two-weeks arc's budget, and what it has spent. */
  nudgesSent: number;
  lastNudgeAt: Date | null;
  /** Consecutive nudges the owner has not answered. */
  unanswered: number;
  /** `/quiet`: nothing is sent before this instant. */
  quietUntil: Date | null;
  updatedAt: Date | null;
}

/** What `beginOnboarding` did: the row, and whether *this* call started it. */
export interface OnboardingStart {
  /**
   * True exactly once in the life of an installation. The claim is a single
   * conditional upsert, so two surfaces racing the same first message produce
   * one `true` and one `false` — never two interviews.
   */
  started: boolean;
  onboarding: Onboarding;
}

/** The owner as the agents address them. Every field may be unset. */
export interface OwnerProfile {
  /** The name they said to use. Not the transport's display name. */
  preferredName: string | null;
  /** An IANA zone. The day every agent means by "today". */
  timezone: string | null;
  /** A language name or tag, as the owner said it. */
  language: string | null;
  /**
   * A short paragraph in the owner's words — who they are, how to address
   * them, how they like answers. Read into every agent's prompt as context.
   */
  about: string | null;
  /** The display name pairing recorded, kept separate and never overwritten. */
  displayName: string | null;
}

/** The profile fields a caller may write. Absent means "leave it alone". */
export interface OwnerProfilePatch {
  preferredName?: string | null;
  timezone?: string | null;
  language?: string | null;
  about?: string | null;
}
