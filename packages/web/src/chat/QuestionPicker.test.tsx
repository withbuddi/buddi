import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { withLinks } from './QuestionPicker';

describe('withLinks', () => {
  it('turns each https address in a question into a link, leaving the rest as text', () => {
    render(<p>{withLinks('Open https://site.tg/studio/auth/device?code=DUTW-5BTQ, check DUTW-5BTQ, then approve?')}</p>);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://site.tg/studio/auth/device?code=DUTW-5BTQ');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText(/check DUTW-5BTQ, then approve\?/)).toBeInTheDocument();
  });

  it('links nothing that is not https', () => {
    render(<p>{withLinks('Is http://x.test or javascript:alert(1) fine?')}</p>);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
