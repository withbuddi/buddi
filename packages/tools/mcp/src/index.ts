/**
 * `@buddi/tool-mcp` — Connections: buddi as an MCP client
 * (docs/connections.md; buddi-planning/specs/mcp-client.md).
 *
 * A built-in plugin with no tools of its own at boot. Every tool it brings is
 * a reviewed connection's, registered while buddi runs as
 * `mcp.<connection>.<tool>` through `ctx.buddi.tools` (host API 1.6), and
 * each connection's host declared through `ctx.buddi.network` (1.7). It owns
 * the `mcp` schema (connections and their reviewed tools) and one vault entry
 * per signed-in connection.
 *
 * The gateway builds the service (`bindConnections`) once it has a pool, a
 * vault and the shared transport, and serves the owner's routes under
 * `/api/connections`; the manifest's `register` hook hands the service the
 * plugin's tools area.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkArea, PluginManifest, ToolsArea } from '@buddi/core/plugin';
import { ConnectionsService, type ConnectionsDeps } from './service.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const PLUGIN = 'mcp';

/** What a manifest instance holds: the tools area its registry handed it, and the service once bound. */
interface Handle {
  tools?: ToolsArea;
  network?: NetworkArea;
  service?: ConnectionsService;
}

const handles = new WeakMap<PluginManifest, Handle>();

/**
 * One manifest per registry: the `register` hook keeps that registry's tools
 * area, so a throwaway registry (`builtInManifests`) never steals the live one.
 */
export function createConnectionsManifest(): PluginManifest {
  const handle: Handle = {};
  const manifest: PluginManifest = {
    name: PLUGIN,
    version: '0.1.0',
    schema: 'mcp',
    migrationsDir: MIGRATIONS_DIR,
    tools: [],
    register: (host) => {
      handle.tools = host.tools;
      handle.network = host.network;
      handle.service?.attachTools(host.tools, host.network);
    },
  };
  handles.set(manifest, handle);
  return manifest;
}

/** The instance `db:migrate` reads. */
export const manifest: PluginManifest = createConnectionsManifest();

/**
 * Build the service for the connections plugin registered in `manifests`
 * (a registry's), attach it to that registry's tools area, and return it.
 * Idempotent per manifest.
 */
export function bindConnections(manifests: readonly PluginManifest[], deps: ConnectionsDeps): ConnectionsService | undefined {
  const found = manifests.find((m) => m.name === PLUGIN && handles.has(m));
  if (!found) return undefined;
  const handle = handles.get(found)!;
  if (handle.service) return handle.service;
  handle.service = new ConnectionsService(deps);
  if (handle.tools) handle.service.attachTools(handle.tools, handle.network);
  return handle.service;
}

/** The service bound for a registry's manifests, if any. */
export function connectionsOf(manifests: readonly PluginManifest[]): ConnectionsService | undefined {
  const found = manifests.find((m) => m.name === PLUGIN && handles.has(m));
  return found ? handles.get(found)!.service : undefined;
}

export { CATALOG, type CatalogCard } from './catalog.js';
export {
  ConnectionError,
  ConnectionsService,
  NEEDS_CLIENT_ID,
  RETRY_MINUTES,
  changedSentence,
  reconnectSentence,
  type ConnectionSignal,
  type ReviewChanges,
  type ConnectionsDeps,
  type ConnectionView,
  type ReviewTool,
  type ReviewView,
  type SignIn,
} from './service.js';
export { STDIO_REFUSAL, checkServerUrl, connectionFetch } from './fetch.js';
export { SERVICE_OPEN, SERVICE_CLOSE, UNTRUSTED_NOTICE, toResult } from './output.js';
export { tierOf, listHash, toolHash, suggestSlug, localNames, NAMESPACE } from './tiers.js';
export { vaultRefFor, ReconnectNeeded } from './tokens.js';
export type { HttpTransport, OAuthPort, OAuthTokens, TransportResponse, VaultPort } from './ports.js';
