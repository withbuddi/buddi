/**
 * Settings → Appearance → In the rail: every plugin rail page on until the
 * owner turns it off, kept by the installation, and a page turned off still
 * opened from Settings → Plugins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import type { PluginPageDescriptor } from '../pages/types';
import { RailPagesPref } from '../views/Settings';
import { Plugins } from '../views/Plugins';
import { Rail } from './Rail';
import { resetRailHiddenForTests, shownOnRail, useRailHidden } from './railHidden';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { rail: vi.fn(), setRailHidden: vi.fn(), plugins: vi.fn(), owner: vi.fn(), focus: vi.fn() },
}));

const page = (plugin: string, id: string, title: string, icon: 'mail' | 'calendar'): PluginPageDescriptor =>
  ({ plugin, id, title, place: 'rail', icon, body: [] }) as unknown as PluginPageDescriptor;
const MAIL = page('email', 'mail', 'Mail', 'mail');
const CALENDAR = page('calendar', 'agenda', 'Calendar', 'calendar');

/** The rail as the shell draws it: the plugin pages, less the hidden ones. */
function ShellRail(): JSX.Element {
  const hidden = useRailHidden();
  return <Rail attention={0} place="#/" onNavigate={() => {}} theme="system" onTheme={() => {}} plugins={shownOnRail([MAIL, CALENDAR], hidden)} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRailHiddenForTests();
  vi.mocked(api.owner).mockResolvedValue({ preferredName: null } as never);
  vi.mocked(api.focus).mockResolvedValue({ focus: null } as never);
  vi.mocked(api.setRailHidden).mockImplementation(async (plugin, p, hidden) => ({ plugin, page: p, hidden }));
});

describe('the rail pages', () => {
  it('shows Mail and Calendar by default, and hides one the moment its switch is turned off', async () => {
    vi.mocked(api.rail).mockResolvedValue({ hidden: [] });
    render(
      <>
        <ShellRail />
        <RailPagesPref pages={[MAIL, CALENDAR]} />
      </>,
    );
    await waitFor(() => expect(api.rail).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: 'Calendar' })).toBeInTheDocument();
    const calendar = screen.getByRole('checkbox', { name: 'Calendar' });
    expect(calendar).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Mail' })).toBeChecked();
    fireEvent.click(calendar);
    await waitFor(() => expect(api.setRailHidden).toHaveBeenCalledWith('calendar', 'agenda', true));
    expect(screen.queryByRole('link', { name: 'Calendar' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mail' })).toBeInTheDocument();
  });

  it('reads what the installation hid, and puts a switch back if the gateway refuses', async () => {
    vi.mocked(api.rail).mockResolvedValue({ hidden: ['email:mail'] });
    vi.mocked(api.setRailHidden).mockRejectedValue(new Error('no rail page'));
    render(
      <>
        <ShellRail />
        <RailPagesPref pages={[MAIL, CALENDAR]} />
      </>,
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Mail' })).not.toBeChecked());
    expect(screen.queryByRole('link', { name: 'Mail' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mail' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Mail' })).not.toBeChecked());
    expect(await screen.findByText('no rail page')).toBeInTheDocument();
  });

  it('lets Settings → Plugins open a page, hidden or not', async () => {
    vi.mocked(api.plugins).mockResolvedValue({
      checkout: true, trust: 'Trust.', staged: [], installed: [], builtIn: [{ name: 'email', version: '1', contribution: { tools: 1, sentinels: 0, views: 0, agents: 0 } }],
    } as never);
    const navigate = vi.fn();
    render(<Plugins railPages={[MAIL, CALENDAR]} navigate={navigate} />);
    fireEvent.click(await screen.findByRole('link', { name: 'Open Mail' }));
    expect(navigate).toHaveBeenCalledWith('#/p/email/mail');
  });
});
