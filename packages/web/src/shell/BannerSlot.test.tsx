/** The banner slot: one strip, the most important candidate first, a count of the rest. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { api } from '../api';
import { RECOVERY_BANNER } from '../views/Recovery';
import { BannerSlot, LOST_BANNER, PAUSED_BANNER, shellBanners } from './BannerSlot';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the banner slot', () => {
  it('is absent while nothing matters', () => {
    const { container } = render(<BannerSlot banners={shellBanners({ recovery: false, lost: false, paused: false })} onNavigate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows recovery over a lost connection over a paused queue, and how many more', () => {
    const { rerender } = render(<BannerSlot banners={shellBanners({ recovery: true, lost: true, paused: true })} onNavigate={() => {}} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(RECOVERY_BANNER);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    rerender(<BannerSlot banners={shellBanners({ recovery: false, lost: true, paused: true })} onNavigate={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(LOST_BANNER);
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'critical');
    expect(screen.getByText('+1 more')).toBeInTheDocument();
    rerender(<BannerSlot banners={shellBanners({ recovery: false, lost: false, paused: true })} onNavigate={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(PAUSED_BANNER);
    expect(screen.queryByText(/more$/)).toBeNull();
  });

  it('orders by priority whatever order the candidates come in', () => {
    render(<BannerSlot banners={[{ id: 'other', priority: 9, tone: 'warning', text: 'Something else.' }, ...shellBanners({ recovery: false, lost: false, paused: true })]} onNavigate={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent(PAUSED_BANNER);
    expect(screen.getByText('+1 more')).toHaveAttribute('title', 'Something else.');
  });

  it("carries each one's action on the right: the checklist is a place, Resume is a click", () => {
    const go = vi.fn();
    const { rerender } = render(<BannerSlot banners={shellBanners({ recovery: true, lost: false, paused: false })} onNavigate={go} />);
    fireEvent.click(screen.getByRole('link', { name: 'Finish the checklist' }));
    expect(go).toHaveBeenCalledWith('#/settings/backup');
    const resume = vi.spyOn(api, 'setPaused').mockResolvedValue({ paused: false });
    rerender(<BannerSlot banners={shellBanners({ recovery: false, lost: false, paused: true })} onNavigate={go} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resume).toHaveBeenCalledWith(false);
  });
});
