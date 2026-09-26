/**
 * The channels registry: who can carry a message to the owner from this
 * process. A channel is registered by whatever owns the transport — the
 * Telegram surface at gateway boot — and core never knows more about it than
 * this shape.
 */
import { ALWAYS_REACH, type ChannelDescription, type DeliverableMessage, type NotificationKind, type NotificationSettings, type OwnerChannel } from './types.js';

const channels = new Map<string, OwnerChannel>();

/** Add a channel; the returned function removes exactly this registration. */
export function registerChannel(channel: OwnerChannel): () => void {
  if (channel.kind === 'dashboard') throw new Error('"dashboard" is a surface, not a channel');
  channels.set(channel.kind, channel);
  return () => {
    if (channels.get(channel.kind) === channel) channels.delete(channel.kind);
  };
}

/** A channel's description, or null when it has nothing to carry a message now. Never throws. */
async function described(channel: OwnerChannel): Promise<ChannelDescription | null> {
  try {
    return (await channel.describe()) ?? null;
  } catch {
    return null;
  }
}

/** The channels there are now, the default-when-none-is-picked first: by `priority`, then as registered. */
async function available(): Promise<Array<{ channel: OwnerChannel; description: ChannelDescription }>> {
  const all = [...channels.values()].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  const answers = await Promise.all(all.map(described));
  return all.flatMap((channel, i) => {
    const description = answers[i];
    return description ? [{ channel, description }] : [];
  });
}

/** Every channel there is now, in the order `available` gives. */
export async function listChannels(): Promise<Array<{ kind: string; label: string; where?: string; can: OwnerChannel['can'] }>> {
  return (await available()).map(({ channel, description }) => ({
    kind: channel.kind,
    label: description.label,
    ...(description.where ? { where: description.where } : {}),
    can: channel.can,
  }));
}

/** Tests only: forget every channel. */
export function clearChannels(): void {
  channels.clear();
}

/**
 * The channel a message of this kind goes to: the kind's own choice when it
 * names a channel there is now, else the default channel, else the first one
 * (by `priority`, then as registered). `off` when the owner turned the kind off; null when there is
 * nowhere to go.
 */
export async function channelFor(settings: NotificationSettings, kind?: string): Promise<string | 'off' | null> {
  const own = kind ? settings.perKind[kind as keyof NotificationSettings['perKind']] : undefined;
  if (own === 'off') return ALWAYS_REACH.has(kind as NotificationKind) ? channelFor(settings) : 'off';
  const there = (await available()).map(({ channel }) => channel.kind);
  if (own && there.includes(own)) return own;
  if (settings.defaultChannel && there.includes(settings.defaultChannel)) return settings.defaultChannel;
  return there[0] ?? null;
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
    if (answer === 'refused') return { ok: false, error: `${(await described(channel))?.label ?? kind} refused it` };
    if ('refused' in answer) return { ok: false, error: answer.refused };
    return { ok: true, id: answer.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
