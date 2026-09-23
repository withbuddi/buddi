/**
 * The Files tab: which conversations get one, and when it reads again.
 *
 * It is not a tool result. It belongs to the conversation's agent and the
 * directory a plugin keeps for it, so the page adds it — never a result, never
 * `canvas.show` — and only when a plugin says, through `GET /api/pages` under
 * `files`, that this agent has a workspace. An agent with none gets no tab.
 *
 * It is pinned (the strip never pushes it into the overflow) and it is not
 * substantial, so it never takes the canvas from what the owner is reading or
 * what the run just produced; it is simply there to be clicked.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ChatMessage } from '../chat/types';
import type { PluginWorkspaceFiles } from '../pages/types';
import type { Renderable } from './types';
import type { FilesViewProps } from './views/FilesView';

export const FILES_TAB_ID = 'workspace-files';

/**
 * How many file changes the conversation has seen: results carrying a `diff`
 * and the `path` it changed. Read by shape, never by tool name — the same
 * shape a tool row unfolds into a diff — so the canvas still knows no plugin.
 */
export function workspaceChanges(messages: readonly ChatMessage[]): number {
  let changes = 0;
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== 'tool_result' || block.ok === false) continue;
      const output = block.output;
      if (output === null || typeof output !== 'object' || Array.isArray(output)) continue;
      const { diff, path } = output as Record<string, unknown>;
      if (typeof diff === 'string' && diff.trim() !== '' && typeof path === 'string' && path !== '') changes += 1;
    }
  }
  return changes;
}

export interface AgentWorkspace {
  files: PluginWorkspaceFiles;
  agentId: string;
  root: string;
}

/**
 * The workspace this agent has, if any plugin keeps one for it. Asked once per
 * agent; every failure — no such route, no session, a plugin that refused —
 * is "no workspace", which is no tab, which is the page as it was.
 */
export function useAgentWorkspace(agentId: string | null | undefined): AgentWorkspace | null {
  const [found, setFound] = useState<AgentWorkspace | null>(null);
  useEffect(() => {
    setFound(null);
    if (!agentId) return undefined;
    let cancelled = false;
    (async () => {
      const body = await api.pages();
      for (const files of Array.isArray(body?.files) ? body.files : []) {
        const answer = await api
          .pageQuery<{ workspace: { name: string } | null }>(files.plugin, files.workspace, { agent: agentId })
          .catch(() => null);
        const workspace = answer?.data?.workspace;
        if (workspace && typeof workspace.name === 'string') return { files, agentId, root: workspace.name };
      }
      return null;
    })()
      .then((result) => { if (!cancelled) setFound(result); })
      .catch(() => { /* no route, no session: no tab */ });
    return () => { cancelled = true; };
  }, [agentId]);
  return found && found.agentId === agentId ? found : null;
}

export function filesRenderable(workspace: AgentWorkspace, revision: number): Renderable {
  return {
    id: FILES_TAB_ID,
    tool: '',
    title: 'Files',
    renderer: 'files',
    props: { files: workspace.files, agentId: workspace.agentId, root: workspace.root, revision } satisfies FilesViewProps,
    at: null,
    source: 'files',
    pinned: true,
    substantial: false,
  };
}
