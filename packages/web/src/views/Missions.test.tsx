/** Missions: a schedule that follows the owner's zone says so; one with a zone named on purpose shows it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, ApiError, type MissionRow } from '../api';
import { Missions } from './Missions';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return { ...original, api: { ...original.api, missions: vi.fn() } };
});

const mission = (id: string, timezone: string, timezoneExplicit: boolean): MissionRow => ({
  id,
  name: id,
  agentId: 'scout',
  prompt: 'p',
  enabled: true,
  alwaysDeliver: false,
  createdAt: '2026-10-01T10:00:00Z',
  schedule: { cron: '0 8 * * *', timezone, timezoneExplicit, revision: 1, misfirePolicy: 'coalesce', deadlineMinutes: null },
  nextRun: null,
  occurrences: [],
  lastNotification: null,
});

describe('Missions', () => {
  it('says "follows your timezone" for a schedule that follows the Profile, and the zone for one named on purpose', async () => {
    vi.mocked(api.missions).mockResolvedValue({ missions: [mission('recap', 'Europe/Lisbon', false), mission('tokyo-market', 'Asia/Tokyo', true)] } as never);
    render(<Missions timezone="Europe/Lisbon" />);
    const follows = await screen.findByText('follows your timezone');
    expect(follows).toHaveAttribute('title', 'Europe/Lisbon');
    expect(screen.getByText(/Asia\/Tokyo/)).toBeInTheDocument();
    expect(screen.queryByText(/Europe\/Lisbon ·/)).toBeNull();
  });
});

describe('missions that stop themselves', () => {
  afterEach(() => cleanup());
  const watch: MissionRow = {
    ...mission('agent:keeper:store-watch', 'UTC', false),
    name: 'Store watch',
    stopWhen: 'the extension is approved', endsAt: '2026-10-31T23:59:59Z', quietRuns: 48, stillUsefulAskedAt: '2026-10-02T10:00:00Z',
  };

  it('asks "Still useful?" with Keep and Stop, and says when the watch stops and ends', async () => {
    vi.mocked(api.missions).mockResolvedValue({ missions: [watch] });
    const keep = vi.spyOn(api, 'keepMission').mockResolvedValue({ id: watch.id, enabled: true });
    const stop = vi.spyOn(api, 'answerStillUseful').mockResolvedValue({ id: watch.id, enabled: false, outcome: 'stopped' });
    render(<Missions timezone="UTC" />);
    expect(await screen.findByText('Still useful?')).toBeInTheDocument();
    expect(screen.getByText(/48 times in a row/)).toBeInTheDocument();
    expect(screen.getByText(/Stops itself when the extension is approved/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(keep).toHaveBeenCalledWith(watch.id));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stop).toHaveBeenCalledWith(watch.id, 'stop'));
  });

  it('lists a watch past its end as ended, with no question', async () => {
    vi.mocked(api.missions).mockResolvedValue({ missions: [{ ...watch, enabled: false, endedAt: '2026-10-31T23:59:59Z', stillUsefulAskedAt: undefined }] });
    render(<Missions timezone="UTC" />);
    expect(await screen.findByText('ended')).toBeInTheDocument();
    expect(screen.queryByText('Still useful?')).not.toBeInTheDocument();
  });
});

describe('where a mission browses', () => {
  afterEach(() => cleanup());

  it('says "Uses your Chrome" or "Own browser" with a switch, and a mission that opens no page has neither', async () => {
    vi.mocked(api.missions).mockResolvedValue({ missions: [
      { ...mission('agent:cfo:pnc-pull', 'UTC', false), name: 'PNC pull', browser: 'own' },
      { ...mission('agent:cfo:bills', 'UTC', false), name: 'Bills', browser: 'owner' },
      { ...mission('recap', 'UTC', false), name: 'Recap' },
    ] });
    const set = vi.spyOn(api, 'setMissionChrome').mockResolvedValue({ id: 'agent:cfo:pnc-pull', browser: 'owner' });
    render(<Missions timezone="UTC" />);
    expect(await screen.findByText('Own browser')).toBeInTheDocument();
    expect(screen.getByText('Uses your Chrome')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Let Recap use your Chrome' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Let Bills use your Chrome' })).toBeChecked();
    const pnc = screen.getByRole('switch', { name: 'Let PNC pull use your Chrome' });
    expect(pnc).not.toBeChecked();
    fireEvent.click(pnc);
    await waitFor(() => expect(set).toHaveBeenCalledWith('agent:cfo:pnc-pull', true));
  });
});

describe('Run now', () => {
  afterEach(() => cleanup());
  const occurrence = (state: string, extra: Partial<MissionRow['occurrences'][number]> = {}): MissionRow['occurrences'][number] => ({
    id: `o-${state}`, scheduledAt: '2026-10-07T09:00:00Z', state, finishedAt: state === 'claimed' || state === 'pending' ? null : '2026-10-07T09:01:00Z', error: null, runConversationId: null, ...extra,
  });

  it('runs a mission on the row, then says "Running…" with the button disabled until the run is done', async () => {
    const brief = { ...mission('brief', 'UTC', false), name: 'Morning brief' };
    vi.mocked(api.missions)
      .mockResolvedValueOnce({ missions: [brief] })
      .mockResolvedValue({ missions: [{ ...brief, occurrences: [occurrence('claimed', { manual: true })] }] });
    const runMission = vi.spyOn(api, 'runMission').mockResolvedValue({ job: 'j1', occurrence: { id: 'o1', scheduledAt: '2026-10-07T09:00:00Z', state: 'claimed', manual: true } });
    render(<Missions timezone="UTC" />);
    const button = await screen.findByRole('button', { name: 'Run now' });
    expect(button).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Last run: none');
    fireEvent.click(button);
    await waitFor(() => expect(runMission).toHaveBeenCalledWith('brief'));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Running…'));
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  });

  it('shows the result the way a scheduled run does: reported, stayed silent, failed', async () => {
    vi.mocked(api.missions).mockResolvedValue({ missions: [
      { ...mission('a', 'UTC', false), name: 'A', occurrences: [occurrence('succeeded', { manual: true })], lastNotification: { kind: 'mission.delivered', at: '2026-10-07T09:01:00Z', chars: 40 } },
      { ...mission('b', 'UTC', false), name: 'B', occurrences: [occurrence('succeeded')], lastNotification: { kind: 'mission.silent', at: '2026-10-07T09:01:00Z', reason: 'nothing new' } },
      { ...mission('c', 'UTC', false), name: 'C', occurrences: [occurrence('failed', { error: 'the model refused' })], lastNotification: null },
    ] });
    render(<Missions timezone="UTC" />);
    await screen.findByText(/Last run reported/);
    expect(screen.getByText(/Last run stayed silent .* — nothing new/)).toBeInTheDocument();
    expect(screen.getByText(/Last run failed .* — the model refused/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Run now' }).every((b) => !b.hasAttribute('disabled'))).toBe(true);
  });

  it('offers no Run now on a mission that is off, and says why a refused run did not start', async () => {
    vi.mocked(api.missions).mockResolvedValue({ missions: [
      { ...mission('off', 'UTC', false), name: 'Off', enabled: false },
      { ...mission('on', 'UTC', false), name: 'On' },
    ] });
    vi.spyOn(api, 'runMission').mockRejectedValue(new ApiError(409, 'On is already running.'));
    render(<Missions timezone="UTC" />);
    expect(await screen.findAllByRole('button', { name: 'Run now' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('On is already running.')).toBeInTheDocument();
  });
});
