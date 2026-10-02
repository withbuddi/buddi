/** Missions: a schedule that follows the owner's zone says so; one with a zone named on purpose shows it. */
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
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
