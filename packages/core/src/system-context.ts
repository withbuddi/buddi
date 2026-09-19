/** Read-only platform capabilities; these are not optional agent grants. */
export const SYSTEM_TOOLS = ['system.time', 'system.info'] as const;

export interface SystemContext {
  timezone: string;
  /** Trusted platform-generated facts, not raw host command output. */
  prompt: string;
}
