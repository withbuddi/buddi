/**
 * The channels registry: who can carry a message to the owner from this
 * process. A channel is registered by whatever owns the transport — the
 * Telegram surface at gateway boot — and core never knows more about it than
 * this shape.
 */
import { ALWAYS_REACH, type DeliverableMessage, type NotificationKind, type NotificationSettings, type OwnerChannel } from './types.js';

const channels = new Map<string, OwnerChannel>();

/** Add a channel; the returned function removes exactly this registration. */
export function registerChannel(channel: OwnerChannel): () => void {
  if (channel.kind === 'dashboard') throw new Error('"dashboard" is a surface, not a channel');
  channels.set(channel.kind, channel);
  return () => {
    if (channels.get(channel.kind) === channel) channels.delete(channel.kind);
  };
}

/** Every channel, in the order they were registered. */
export function listChannels(): Array<{ kind: string; label: string; where?: string; can: OwnerChannel['can'] }> {
  return [...channels.values()].map((c) => ({ kind: c.kind, ...c.describe(), can: c.can }));
}

/** Tests only: forget every channel. */
export function clearChannels(): void {
  channels.clear();
}

/**
 * The channel a message of this kind goes to: the kind's own choice when it
 * names a registered channel, else the default channel, else the first one
 * registered. `off` when the owner turned the kind off; null when there is
 * nowhere to go.
 */
export function channelFor(settings: NotificationSettings, kind?: string): string | 'off' | null {
  const own = kind ? settings.perKind[kind as keyof NotificationSettings['perKind']] : undefined;
  if (own === 'off') return ALWAYS_REACH.has(kind as NotificationKind) ? channelFor(settings) : 'off';
  if (own && channels.has(own)) return own;
  if (settings.defaultChannel && channels.has(settings.defaultChannel)) return settings.defaultChannel;
  for (const k of channels.keys()) if (k !== 'dashboard') return k;
  return null;
}

/**
 * Hand a message to one channel. Never throws: a channel that refuses or
 * throws is an answer, written on the row by the caller.
 */
export async function deliverTo(
  kind: string,
  message: DeliverableMessage,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const channel = channels.get(kind);
  if (!channel) return { ok: false, error: 'no channel' };
  try {
    const answer = await channel.deliver(message);
    if (answer === 'refused') return { ok: false, error: `${channel.describe().label} refused it` };
    return { ok: true, id: answer.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
