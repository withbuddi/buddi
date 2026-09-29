/**
 * Settings → Notifications: the channels with a test each, a select per
 * kind, the focus schedules, one save, and the last twenty.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, type NotificationSettingsView } from '../api';
import { Notifications } from './Notifications';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      notificationSettings: vi.fn(),
      saveNotificationSettings: vi.fn(),
      testChannel: vi.fn(),
      notifications: vi.fn(),
      telegramBot: vi.fn(),
      telegramDevices: vi.fn(),
      saveTelegramToken: vi.fn(),
      telegramPairing: vi.fn(),
      unpairTelegramDevice: vi.fn(),
      tipsSettings: vi.fn(),
      saveTipsSettings: vi.fn(),
    },
  };
});

const VIEW: NotificationSettingsView = {
  settings: { defaultChannel: null, perKind: {}, schedules: [], endOfDay: '18:00' },
  channels: [{ kind: 'telegram.chat', label: 'Telegram', where: '@buddi_bot', can: { offers: true, attachments: false, markdown: false } }],
};

const PHONE = { id: 'p1', name: 'Amen', userId: '4242', pairedAt: '2026-09-20T10:00:00.000Z', lastSeenAt: '2026-09-25T08:00:00.000Z' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.notificationSettings).mockResolvedValue(VIEW);
  vi.mocked(api.saveNotificationSettings).mockImplementation(async (settings) => ({ settings, channels: VIEW.channels }));
  vi.mocked(api.testChannel).mockResolvedValue({ ok: true });
  vi.mocked(api.telegramBot).mockResolvedValue({ configured: true, running: true, username: 'buddi_bot' });
  vi.mocked(api.telegramDevices).mockResolvedValue({ devices: [PHONE] });
  vi.mocked(api.unpairTelegramDevice).mockResolvedValue(null);
  vi.mocked(api.tipsSettings).mockResolvedValue({ enabled: true });
  vi.mocked(api.saveTipsSettings).mockImplementation(async (enabled) => ({ enabled }));
  vi.mocked(api.notifications).mockResolvedValue({
    notifications: [
      {
        id: 'n1', kind: 'failure', urgency: 'now', title: 'Three jobs died', text: null, link: null, agentId: null, pluginId: null,
        actionId: null, state: 'failed', dueAt: null, channel: null, createdAt: '2026-09-25T10:00:00.000Z', sentAt: null,
        seenAt: null, actedAt: null, error: 'no channel',
      },
      {
        id: 'n2', kind: 'watcher', urgency: 'now', title: 'Rent is due', text: null, link: null, agentId: null, pluginId: null,
        actionId: null, state: 'sent', dueAt: null, channel: 'telegram.chat', createdAt: '2026-09-25T09:00:00.000Z', sentAt: null,
        seenAt: '2026-09-25T09:05:00.000Z', actedAt: null, error: null,
      },
    ],
  });
});
afterEach(() => cleanup());

async function page(): Promise<void> {
  await act(async () => { render(<Notifications timezone="UTC" />); });
}

describe('Settings → Notifications', () => {
  it('lists the channels, the kinds and the last twenty', async () => {
    await page();
    expect(screen.getByRole('radio', { name: /Telegram, @buddi_bot/ })).toBeChecked();
    // Approvals and questions cannot be off; the rest can.
    const approvals = screen.getByRole('combobox', { name: 'Approvals' });
    expect(within(approvals).queryByRole('option', { name: 'Off' })).toBeNull();
    expect(within(screen.getByRole('combobox', { name: 'Watchers' })).getByRole('option', { name: 'Off' })).toBeInTheDocument();
    expect(screen.getByText('Do not disturb holds everything but approvals and questions', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Failed: no channel')).toBeInTheDocument();
    expect(screen.getByText(/failures · dashboard/)).toBeInTheDocument();
    expect(screen.getByText(/watchers · Telegram/)).toBeInTheDocument();
  });

  it('saves the whole value and says so', async () => {
    await page();
    fireEvent.change(screen.getByRole('combobox', { name: 'Watchers' }), { target: { value: 'off' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(api.saveNotificationSettings).toHaveBeenCalledWith({
      defaultChannel: null, perKind: { watcher: 'off' }, schedules: [], endOfDay: '18:00',
    });
    expect(screen.getByText('Saved.')).toBeInTheDocument();
  });

  it('shows the sentence the server refuses with', async () => {
    vi.mocked(api.saveNotificationSettings).mockRejectedValue(new ApiError(400, 'Schedule 1 needs at least one day.'));
    await page();
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(screen.getByText('Schedule 1 needs at least one day.')).toBeInTheDocument();
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('edits the focus schedules: add, mode, days, times, remove', async () => {
    vi.mocked(api.notificationSettings).mockResolvedValue({
      ...VIEW,
      settings: { ...VIEW.settings, schedules: [{ mode: 'do-not-disturb', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], from: '22:00', to: '07:00' }] },
    });
    await page();
    expect(screen.getByLabelText('Schedule 1 from')).toHaveValue('22:00');
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Schedule 2 mode' }), { target: { value: 'urgent-only' } });
    for (const day of ['Sat', 'Sun', 'Mon']) fireEvent.click(screen.getByRole('button', { name: `Schedule 2 ${day}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Schedule 2 Mon' }));
    expect(screen.getByRole('button', { name: 'Schedule 2 Mon' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Schedule 2 Sat' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.change(screen.getByLabelText('Schedule 2 from'), { target: { value: '09:00' } });
    fireEvent.change(screen.getByLabelText('Schedule 2 to'), { target: { value: '12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove schedule 1' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    expect(api.saveNotificationSettings).toHaveBeenCalledWith({
      defaultChannel: null, perKind: {}, endOfDay: '18:00',
      schedules: [{ mode: 'urgent-only', days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '09:00', to: '12:00' }],
    });
  });

  it('sends a test through a channel, and says when it did not go', async () => {
    await page();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send a test' })); });
    expect(api.testChannel).toHaveBeenCalledWith('telegram.chat');
    expect(screen.getByText('Sent. Check that it arrived.')).toBeInTheDocument();
    vi.mocked(api.testChannel).mockRejectedValue(new ApiError(502, 'The test did not go through: Telegram refused it.'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send a test' })); });
    expect(screen.getByText('The test did not go through: Telegram refused it.')).toBeInTheDocument();
  });

  it('says how to get a channel when there is none', async () => {
    vi.mocked(api.notificationSettings).mockResolvedValue({ ...VIEW, channels: [] });
    await page();
    expect(screen.getByText(/Pair Telegram and buddi can reach you/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send a test' })).toBeNull();
  });
});

describe('Settings → Notifications → Telegram', () => {
  it('asks for a token when there is none, and saves it', async () => {
    vi.mocked(api.telegramBot).mockResolvedValue({ configured: false, running: false, username: null });
    vi.mocked(api.telegramDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.saveTelegramToken).mockResolvedValue({ configured: true, running: true, paired: false, restartNeeded: false, botUsername: 'buddi_bot' });
    await page();
    expect(screen.getByText('Ask @BotFather for a bot and paste its token here.')).toBeInTheDocument();
    expect(screen.getByText('No phone is paired yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pair a phone' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '8012345678:AAHfakeTokenForTestsOnly-1234567890' } });
    vi.mocked(api.telegramBot).mockResolvedValue({ configured: true, running: true, username: 'buddi_bot' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save token' })); });
    expect(api.saveTelegramToken).toHaveBeenCalledWith('8012345678:AAHfakeTokenForTestsOnly-1234567890');
    expect(await screen.findByText('Bot: @buddi_bot')).toBeInTheDocument();
    // The channel list is read again: Telegram can appear there now.
    expect(vi.mocked(api.notificationSettings).mock.calls.length).toBeGreaterThan(1);
  });

  it('names the bot, lists the phone, and unpairs it after asking in place', async () => {
    await page();
    expect(screen.getByText('Bot: @buddi_bot')).toBeInTheDocument();
    expect(screen.queryByLabelText('Bot token')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace token' }));
    expect(screen.getByLabelText('Bot token')).toBeInTheDocument();
    expect(screen.getByText('Amen')).toBeInTheDocument();
    expect(screen.getByText(/Paired 20 Sep.*last spoke/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Unpair' }));
    expect(api.unpairTelegramDevice).not.toHaveBeenCalled();
    expect(screen.getByText('It will no longer reach your agents.')).toBeInTheDocument();
    vi.mocked(api.telegramDevices).mockResolvedValue({ devices: [] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Unpair' })); });
    expect(api.unpairTelegramDevice).toHaveBeenCalledWith('p1');
    expect(await screen.findByText('No phone is paired yet.')).toBeInTheDocument();
  });

  it('pairs a phone: the square, the link to copy, then Paired. when a new phone arrives', async () => {
    const link = 'tg://resolve?domain=buddi_bot&start=ABC';
    vi.mocked(api.telegramPairing).mockResolvedValue({ code: 'ABC', link, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    await page();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pair a phone' })); });
    expect(await screen.findByText('Open this on your phone, then send /start to the bot.')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: link })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: link })).toHaveAttribute('href', link);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByText(/The code works until/)).toBeInTheDocument();

    // The phone already paired is not the new one; a second is.
    const second = { ...PHONE, id: 'p2', name: 'Work phone', lastSeenAt: null };
    vi.mocked(api.telegramDevices).mockResolvedValue({ devices: [PHONE, second] });
    expect(await screen.findByText('Paired.', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(await screen.findByText('Work phone')).toBeInTheDocument();
    expect(vi.mocked(api.notificationSettings).mock.calls.length).toBeGreaterThan(1);
  });

  it('turns tips on Home off and on, saved at once', async () => {
    await page();
    const box = screen.getByRole('checkbox', { name: 'Tips on Home' });
    expect(box).toBeChecked();
    await act(async () => { fireEvent.click(box); });
    expect(api.saveTipsSettings).toHaveBeenCalledWith(false);
    expect(box).not.toBeChecked();
    await act(async () => { fireEvent.click(box); });
    expect(api.saveTipsSettings).toHaveBeenLastCalledWith(true);
    expect(box).toBeChecked();
  });
});
