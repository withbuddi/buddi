import type { CodexRpc } from './codex-rpc.js';

/** Pinned configuration, coupled with an empty native skill-catalog preflight. */
export const CODEX_EXPERIMENT_CONFIG: Record<string, unknown> = {
  approval_policy: 'on-request',
  sandbox_mode: 'read-only',
  web_search: 'disabled',
  cli_auth_credentials_store: 'file',
  forced_login_method: 'chatgpt',
  mcp_servers: {},
  notify: [],
  hooks: {},
  project_doc_max_bytes: 0,
  check_for_update_on_startup: false,
  'history.persistence': 'none',
  'analytics.enabled': false,
  'feedback.enabled': false,
  'agents.enabled': false,
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.shell_snapshot': false,
  'features.view_image': false,
  'tools.view_image': false,
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.hooks': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.computer_use': false,
  'features.in_app_browser': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.memories': false,
  'features.workspace_dependencies': false,
  'features.skill_mcp_dependency_install': false,
  'features.skip_host_skill_discovery': true,
  'features.skill_search': false,
  'features.code_mode': false,
  'features.code_mode_host': false,
  'features.image_generation': false,
  'features.goals': false,
  'features.sleep_tool': false,
  'features.tool_suggest': false,
};

export function codexConfigArgs(config: Record<string, unknown>): string[] {
  return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}

export async function assertCodexIsolation(rpc: CodexRpc, cwd: string): Promise<void> {
  const read = await rpc.request('config/read', { includeLayers: false }) as { config?: Record<string, unknown> };
  const config = read?.config;
  const features = config?.features as Record<string, unknown> | undefined;
  if (!config || config.sandbox_mode !== 'read-only' || config.web_search !== 'disabled' ||
    !features || Object.entries(CODEX_EXPERIMENT_CONFIG).some(([key, value]) =>
      key.startsWith('features.') && features[key.slice('features.'.length)] !== value) ||
    Object.values((config.mcp_servers ?? {}) as Record<string, { enabled?: boolean }>).some(server => server.enabled !== false)) {
    throw new Error('Codex isolation check failed: effective native tool restrictions do not match.');
  }
  const result = await rpc.request('skills/list', { cwds: [cwd], forceReload: true }) as {
    data?: Array<{ cwd?: string; skills?: Array<{ path?: string; enabled?: boolean }>; errors?: unknown[] }>;
  };
  if (!Array.isArray(result?.data) || result.data.length !== 1 ||
    !Array.isArray(result.data[0]?.skills) || result.data[0].skills.length > 1000 ||
    result.data[0].errors?.length) {
    throw new Error('Codex isolation check failed: native skill catalog must be empty.');
  }
  for (const skill of result.data[0].skills) {
    if (typeof skill.path !== 'string') throw new Error('Invalid Codex skill catalog.');
    // This changes ONLY the freshly-created private Codex profile's config,
    // never the discovered skill file or the owner's real Codex settings.
    if (skill.enabled !== false) await rpc.request('skills/config/write', { path: skill.path, enabled: false });
  }
  const checked = await rpc.request('skills/list', { cwds: [cwd], forceReload: true }) as typeof result;
  if (!Array.isArray(checked?.data) || checked.data.length !== 1 ||
    !Array.isArray(checked.data[0]?.skills) || checked.data[0].errors?.length ||
    checked.data[0].skills.some(skill => skill.enabled !== false)) {
    throw new Error('Codex isolation check failed: native skills remain enabled.');
  }
}
