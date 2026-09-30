/**
 * `owner.notify` as the page reads it: what the agent sent, and the sentence
 * the tool answered with about where it went (docs/notifications.md).
 */
import type { Tone } from '../ui';

export const NOTIFY_TOOL = 'owner.notify';

export interface NotifyCall {
  title: string;
  text: string | null;
  urgency: string;
  key: string | null;
  link: string | null;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

export function notifyCall(input: unknown): NotifyCall {
  const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    title: str(record['title']) ?? '(no title)',
    text: str(record['text']),
    urgency: str(record['urgency']) ?? 'now',
    key: str(record['key']),
    link: str(record['link']),
  };
}

/** "sent to Telegram", "held until Do not disturb ends", …: the tool's own sentence. */
export function deliveredOf(output: unknown): string | null {
  if (output === null || typeof output !== 'object') return str(output);
  const record = output as Record<string, unknown>;
  return str(record['delivered']) ?? str(record['message']) ?? str(record['error']);
}

/** Green when it went out, red when it was refused, amber for held, lowered or in a summary. */
export function deliveredTone(sentence: string | null, ok: boolean): Tone {
  if (!ok || !sentence) return 'critical';
  const s = sentence.toLowerCase();
  if (/^(refused|not sent)/.test(s)) return 'critical';
  if (/^sent\b/.test(s)) return 'good';
  return 'warning';
}
