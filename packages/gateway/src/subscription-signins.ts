/**
 * Signing in with a subscription: Claude (browser OAuth) and ChatGPT (through
 * Codex). Both are offered unless the owner hides them.
 *
 * `BUDDI_SUBSCRIPTION_SIGNINS=off` hides both. Anything else, unset included,
 * leaves them on. For one release the two old experiment variables still count
 * in one direction only: `=0` on either hides that one sign-in, and the doctor
 * says the variable is old and names the new one.
 */

export const SUBSCRIPTION_SIGNINS_VAR = 'BUDDI_SUBSCRIPTION_SIGNINS';

/** The old per-sign-in flags, read only so `=0` keeps hiding one. */
export const OLD_SIGNIN_VARS = {
  claude: 'BUDDI_ANTHROPIC_OAUTH_EXPERIMENT',
  codex: 'BUDDI_CODEX_EXPERIMENT',
} as const;

export interface SubscriptionSignIns {
  claude: boolean;
  codex: boolean;
  /** Old variables that are set at all, whatever their value. */
  oldVars: string[];
}

export function subscriptionSignIns(env: NodeJS.ProcessEnv): SubscriptionSignIns {
  const hidden = (env[SUBSCRIPTION_SIGNINS_VAR] ?? '').trim().toLowerCase() === 'off';
  const oldOff = (name: string): boolean => (env[name] ?? '').trim() === '0';
  return {
    claude: !hidden && !oldOff(OLD_SIGNIN_VARS.claude),
    codex: !hidden && !oldOff(OLD_SIGNIN_VARS.codex),
    oldVars: Object.values(OLD_SIGNIN_VARS).filter((name) => (env[name] ?? '').trim() !== ''),
  };
}

/** The sentence an owner gets when a hidden sign-in is asked for anyway. */
export const SIGNIN_HIDDEN = {
  claude: 'Claude subscription sign-in is turned off on this host.',
  codex: 'ChatGPT subscription sign-in is turned off on this host.',
} as const;
