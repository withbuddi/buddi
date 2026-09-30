import { beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type ConnectionView, type ConnectionsView } from '../../api';
import { AgentConnections } from './AgentConnections';

vi.mock('../../api', () => ({ api: { connections: vi.fn(), setConnectionHolder: vi.fn() } }));

const connection = (over: Partial<ConnectionView>): ConnectionView => ({
  id: '00000000-0000-4000-8000-000000000001', slug: 'tracker', name: 'Tracker', url: 'https://mcp.example.com', host: 'mcp.example.com',
  state: 'connected', authKind: 'oauth', signedIn: true, toolCount: 3, grant: 'mcp.tracker.*', serverName: null, serverVersion: null,
  reviewedAt: null, agents: [], ...over,
});
const view = (connections: ConnectionView[], agents = [{ id: 'demo', name: 'Demo', handle: 'demo', frontDesk: true }]): ConnectionsView =>
  ({ connections, catalog: [], agents, vault: true, callbackPath: '/connections/callback' });

beforeEach(() => { vi.clearAllMocks(); });

it('says so in one line, with a way to Connections, when nothing is connected', async () => {
  vi.mocked(api.connections).mockResolvedValue(view([]));
  render(<AgentConnections agentId="demo" agentName="Demo" readOnly={false} version="" />);
  const link = await screen.findByRole('link', { name: /Connect a service/ });
  expect(link).toHaveAttribute('href', '#/settings/connections');
  expect(screen.queryByRole('switch')).toBeNull();
});

it('gives and takes a connection with its switch, saved at once for this agent only', async () => {
  const onSaved = vi.fn();
  vi.mocked(api.connections).mockResolvedValue(view([
    connection({}),
    connection({ id: '00000000-0000-4000-8000-000000000002', slug: 'fx', name: 'Files', transport: 'stdio', host: '', toolCount: 1, agents: ['demo'] }),
  ]));
  vi.mocked(api.setConnectionHolder).mockImplementation(async (id, agent, held) => ({ agent, held, connection: connection({ id }) }));
  render(<AgentConnections agentId="demo" agentName="Demo" readOnly={false} version="" onSaved={onSaved} />);
  const tracker = await screen.findByRole('switch', { name: /Tracker/ });
  const files = screen.getByRole('switch', { name: /Files/ });
  expect(tracker).not.toBeChecked();
  expect(files).toBeChecked();
  expect(screen.getByText('mcp.example.com · 3 tools')).toBeInTheDocument();
  expect(screen.getByText('on this computer · 1 tool')).toBeInTheDocument();

  fireEvent.click(tracker);
  await waitFor(() => expect(api.setConnectionHolder).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'demo', true));
  await waitFor(() => expect(tracker).toBeChecked());
  expect(onSaved).toHaveBeenCalled();
  fireEvent.click(files);
  await waitFor(() => expect(api.setConnectionHolder).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002', 'demo', false));
  await waitFor(() => expect(files).not.toBeChecked());
});

it('shows a connection that needs review or a sign-in with why, its switch off until it is ready', async () => {
  vi.mocked(api.connections).mockResolvedValue(view([
    connection({ state: 'needs-review' }),
    connection({ id: '00000000-0000-4000-8000-000000000003', name: 'Mail', state: 'needs-reconnect' }),
    connection({ id: '00000000-0000-4000-8000-000000000004', name: 'Held', state: 'needs-reconnect', agents: ['demo'] }),
  ]));
  render(<AgentConnections agentId="demo" agentName="Demo" readOnly={false} version="" />);
  expect(await screen.findByRole('switch', { name: /Tracker/ })).toBeDisabled();
  expect(screen.getByRole('switch', { name: /Mail/ })).toBeDisabled();
  // One it holds can still be taken away.
  expect(screen.getByRole('switch', { name: /Held/ })).toBeEnabled();
  expect(screen.getByText(/need your review/)).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Open Connections' })[0]).toHaveAttribute('href', '#/settings/connections');
});

it('shows a refused change and keeps the switch where it was', async () => {
  vi.mocked(api.connections).mockResolvedValue(view([connection({})]));
  vi.mocked(api.setConnectionHolder).mockRejectedValue(new Error('The file is read-only.'));
  render(<AgentConnections agentId="demo" agentName="Demo" readOnly={false} version="" />);
  const tracker = await screen.findByRole('switch', { name: /Tracker/ });
  fireEvent.click(tracker);
  expect(await screen.findByRole('alert')).toHaveTextContent('The file is read-only.');
  expect(tracker).not.toBeChecked();
});
