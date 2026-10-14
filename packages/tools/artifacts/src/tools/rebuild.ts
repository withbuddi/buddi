/**
 * The owner's yes before an agent's write replaces his own version of a
 * document (docs/files.md, "Office documents"): `artifacts.write` rebuilding
 * a .docx from Markdown, `artifacts.compose` composing over his Word save.
 *
 * Nothing the model passes is enough. `confirmedRebuild: true` only says
 * "I asked the owner"; the call then becomes an approval card (the tool's
 * tier is decided per call, `tierFor`), bound to the file, the version it
 * would replace and a hash of what would replace it, and runs only once he
 * approved it — as that action, which is what the host's save checks. A
 * version saved meanwhile changes the card's envelope, so the approval no
 * longer matches and nothing is written.
 */
import { createHash } from 'node:crypto';
import type { EffectDescription, FilesArea, ToolContext } from '@buddi/core/plugin';

type Target = { base: string; ext: string; of?: string };

/** The newest version a write would replace when it is the owner's, or null. */
async function ownersVersion(files: FilesArea, version: Target, composing: boolean) {
  const check = await files.rebuildCheck({ version, ...(composing ? { composing: true } : {}) });
  return check?.need === 'owner' ? check : null;
}

/** `tierFor`: gated (a card) only when the agent says it asked and the newest version is the owner's. */
export async function rebuildTier(ctx: ToolContext, version: Target, composing: boolean, confirmed: boolean | undefined): Promise<{ tier: 'auto' | 'gated' }> {
  const files = ctx.buddi?.files;
  if (confirmed !== true || !files) return { tier: 'auto' };
  // The card says it all (`rebuildDescription`); no reason is added to it.
  return (await ownersVersion(files, version, composing)) ? { tier: 'gated' } : { tier: 'auto' };
}

/** The card: what is replaced, by what, bound to the version and the content. */
export async function rebuildDescription(ctx: ToolContext, version: Target, composing: boolean, content: string): Promise<EffectDescription> {
  const owners = await ownersVersion(ctx.buddi!.files!, version, composing);
  const name = owners?.name ?? `${version.base}.${version.ext}`;
  const by = composing ? "buddi's program" : "the agent's text";
  return {
    envelope: {
      fileId: owners?.fileId ?? null,
      replaces: owners?.version ?? null,
      sha256: createHash('sha256').update(content).digest('hex'),
      composing,
    },
    preview: `Rebuild ${name}? Your edits in v${owners?.version ?? '?'} would be replaced by ${by}; formatting rebuilt.`,
  };
}
