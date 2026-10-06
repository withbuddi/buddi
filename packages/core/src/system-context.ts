/** Read-only platform capabilities; these are not optional agent grants. */
export const SYSTEM_TOOLS = ['system.time', 'system.info'] as const;

export interface SystemContext {
  timezone: string;
  /** Trusted platform-generated facts, not raw host command output. */
  prompt: string;
  /**
   * The owner's profile language as they typed it ("French", "pt-BR"), or
   * absent. The runtime's reply-language guard falls back to it when the
   * owner's message is too short to tell which language it is in.
   */
  language?: string;
}
