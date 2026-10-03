/** Missions: a schedule that follows the owner's zone says so; one with a zone named on purpose shows it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type MissionRow } from '../api';
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
