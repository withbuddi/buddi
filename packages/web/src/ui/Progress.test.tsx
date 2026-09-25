import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { Progress } from './index';
import { installLine } from '../views/parts/InstallProgress';

describe('Progress', () => {
  it('is a progressbar with its value, clamped and rounded, and a fill that wide', () => {
    const { rerender } = render(<Progress value={45.4} label="Fetching the browser" />);
    const bar = screen.getByRole('progressbar', { name: 'Fetching the browser' });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuenow', '45');
    expect((bar.querySelector('.ui-progress-fill') as HTMLElement).style.inlineSize).toBe('45%');
    rerender(<Progress value={180} label="Fetching the browser" />);
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    rerender(<Progress value={Number.NaN} label="Fetching the browser" />);
    expect(bar).toHaveAttribute('aria-valuenow', '0');
  });

  it('is drawn in tokens: an accent fill on a hairline track, and no transition under reduced motion', () => {
    const css = readFileSync(path.join(__dirname, '..', 'ui.css'), 'utf8');
    const block = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(block('.ui-progress')).toContain('background: var(--line)');
    expect(block('.ui-progress')).toContain('block-size: var(--space-1)');
    expect(block('.ui-progress')).toContain('border-radius: var(--radius-pill)');
    expect(block('.ui-progress-fill')).toContain('background: var(--accent)');
    expect(block('.ui-progress')).not.toMatch(/\d+px/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.ui-progress-fill \{ transition: none; \}/);
  });
});

describe('installLine', () => {
  it('says the install in buddi\'s words, never the installer\'s', () => {
    expect(installLine(undefined)).toBe('Fetching the browser…');
    expect(installLine({ phase: 'downloading', percent: 45, what: 'Chromium', download: 1 })).toBe('Fetching Chromium… 45%');
    expect(installLine({ phase: 'installing', percent: 100, what: 'Chromium headless shell', download: 2 })).toBe('Setting up Chromium headless shell…');
    expect(installLine({ phase: 'done', percent: 100, what: 'Chromium', download: 3 })).toBe('Installed.');
  });
});
