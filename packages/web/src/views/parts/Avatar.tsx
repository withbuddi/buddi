/**
 * An agent's face, wherever it appears: the same source everywhere, so the day
 * an agent gets a picture or a colour it changes in every place at once.
 *
 * Order of truth: the picture the owner uploaded (served from the database),
 * else the icon its file names — an image its folder ships or an emoji — else
 * its initials on its accent's soft ground. A picture that fails to load falls
 * back to the icon rather than a broken image. The accent (see
 * `shell/accent.ts`) travels as `data-agent`, plus one custom property when
 * the agent chose its own colour; nothing else is styled inline.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import type { ChatAgent } from '../../chat/types';
import { accentAttrs, accentOf } from '../../shell/accent';
import { tintOf } from '../../shell/AgentRail';
import { monogram } from '../../shell/roster';
import { Blob, useIsBlobStill } from '../../ui/Blob';
import { mascotUrl, type MascotAnimState } from '../meet/script';

export type Face = Pick<ChatAgent, 'avatar' | 'accent' | 'picture'> & {
  roles?: readonly string[] | undefined;
  /** Its granted tools: their families pick a colour when nothing else does. */
  tools?: readonly string[] | undefined;
};

/**
 * The one component that draws a face's mark. `className` is the frame it
 * sits in — `ui-avatar` on a page, `wb-face-mark` in the rail — and every
 * frame styles `data-kind` the same way.
 */
export function FaceMark({
  className,
  id,
  name,
  face,
  tint,
  size,
  unavailable,
  initials = 2,
}: {
  className: string;
  /** The agent's id: with it the mark wears the agent's accent. */
  id?: string | undefined;
  name: string;
  face?: Face | undefined;
  tint?: number | string | undefined;
  size?: 'sm' | 'lg' | 'xl' | undefined;
  unavailable?: boolean | undefined;
  /** How many letters of the monogram to draw when it comes to that. */
  initials?: 1 | 2;
}): JSX.Element {
  const [broken, setBroken] = useState<string | null>(null);
  const picture = face?.picture && face.picture !== broken ? face.picture : undefined;
  const icon = face?.avatar;
  const kind = picture ? 'image' : icon?.kind;
  const accent = id ? accentAttrs(accentOf({ id, accent: face?.accent, roles: face?.roles, tools: face?.tools })) : undefined;
  return (
    <span
      className={className}
      data-tint={accent ? undefined : tint}
      data-size={size}
      data-kind={kind}
      data-unavailable={unavailable ? 'true' : undefined}
      {...accent}
      aria-hidden="true"
    >
      {picture ? (
        <img src={picture} alt="" onError={() => setBroken(picture)} />
      ) : icon?.kind === 'image' ? (
        <img src={icon.url} alt="" />
      ) : icon?.kind === 'emoji' ? (
        icon.value
      ) : (
        monogram(name).slice(0, initials)
      )}
    </span>
  );
}

export function Avatar({
  id,
  name,
  size,
  unavailable,
  face,
}: {
  id: string;
  name: string;
  size?: 'sm' | 'lg' | 'xl';
  unavailable?: boolean;
  face?: Face;
}): JSX.Element {
  return <FaceMark className="ui-avatar" id={id} tint={tintOf(id)} name={name} size={size} unavailable={unavailable} face={face} />;
}

/**
 * The id an action carries when buddi itself asked, not an agent: the MCP
 * server (`buddi.ask` and the admin writes), the dashboard's own flows and the
 * plugin host all run as core's `OWNER_AGENT_ID`. No agent can hold it (it is
 * a reserved id), so it never names a teammate.
 */
export const PLATFORM_ASKER_ID = 'owner';
/** How the platform is named on a card: always lowercase, like the product. */
export const PLATFORM_NAME = 'buddi';

/** Whether this asker is buddi itself rather than one of the agents. */
export function isPlatformAsker(id: string | null | undefined): boolean {
  return id === PLATFORM_ASKER_ID;
}

/** Who asked, as a card names them: "buddi" for the platform, else the roster's name (or the id). */
export function askerName(id: string, agents: readonly Pick<ChatAgent, 'id' | 'name'>[] = []): string {
  if (isPlatformAsker(id)) return PLATFORM_NAME;
  return agents.find((a) => a.id === id)?.name ?? id;
}

/**
 * buddi's own face: the Blob, through the same `Avatar` the chat header draws
 * the front desk with, so the mark matches wherever buddi speaks. A Blob that
 * fails to load falls back to the monogram like any face.
 */
export function PlatformAvatar({ size }: { size?: 'sm' | 'lg' | 'xl' }): JSX.Element {
  return <Avatar id={PLATFORM_ASKER_ID} name={PLATFORM_NAME} size={size} face={{ picture: mascotUrl('core') }} />;
}

/** The face of an agent in a roster, by id: falls back to initials for an id the roster does not know. */
export function AgentAvatar({
  agents,
  id,
  size,
}: {
  agents: readonly ChatAgent[];
  id: string;
  size?: 'sm' | 'lg' | 'xl';
}): JSX.Element {
  if (isPlatformAsker(id)) return <PlatformAvatar size={size} />;
  const agent = agents.find((a) => a.id === id);
  return <Avatar id={id} name={agent?.name ?? id} size={size} unavailable={agent ? !agent.available : false} face={agent} />;
}

/**
 * The mascot slot.
 *
 * Empty states and the Home greeting leave room for the default agent's face —
 * but only the picture the owner uploaded for it (`/api/agents/:id/avatar`).
 * The art lives with the design repo; first run bundles copies to offer as a
 * face, but even those reach an agent only as an upload. With no picture, or one that fails to load, the slot
 * draws nothing — never a monogram, an emoji or a placeholder blob.
 */
const MascotContext = createContext<string | null>(null);

export function MascotProvider({ picture, children }: { picture: string | null | undefined; children: ReactNode }): JSX.Element {
  return <MascotContext.Provider value={picture ?? null}>{children}</MascotContext.Provider>;
}

/**
 * `anim` lets the face move — only when the picture is the bundled Blob, whose
 * loop it then plays in the same box (see `useIsBlobStill`).
 */
export function Mascot({ size, anim }: { size?: 'sm' | 'lg' | undefined; anim?: MascotAnimState }): JSX.Element | null {
  const picture = useContext(MascotContext);
  const [broken, setBroken] = useState<string | null>(null);
  const isBlob = useIsBlobStill(anim ? picture : null);
  if (!picture || picture === broken) return null;
  return (
    <span className="ui-mascot" data-size={size} data-testid="mascot" aria-hidden="true">
      {anim && isBlob
        ? <Blob state={anim} still={picture} className="ui-mascot-blob" onStillError={() => setBroken(picture)} />
        : <img src={picture} alt="" onError={() => setBroken(picture)} />}
    </span>
  );
}
