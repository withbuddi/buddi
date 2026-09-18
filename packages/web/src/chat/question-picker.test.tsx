import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuestionPicker } from './QuestionPicker';

const question = {
  id: 'q1',
  question: 'Which account?',
  options: [
    { id: 'checking', label: 'Checking', hint: 'Best match', recommended: true },
    { id: 'savings', label: 'Savings', hint: null, recommended: false },
  ],
  allowOther: true,
  expiresAt: '2026-09-17T23:00:00Z',
};

describe('structured question picker', () => {
  it('answers an exact option in one click and says it is not approval', () => {
    const answer = vi.fn();
    render(<QuestionPicker question={question} disabled={false} onAnswer={answer} />);
    fireEvent.click(screen.getByText('Checking'));
    expect(answer).toHaveBeenCalledWith('Checking', 'checking');
    expect(screen.getByText(/does not approve an action/i)).toBeDefined();
  });

  it('allows a free-text answer when the question permits it', () => {
    const answer = vi.fn();
    render(<QuestionPicker question={question} disabled={false} onAnswer={answer} />);
    fireEvent.change(screen.getByPlaceholderText('Something else…'), { target: { value: 'Brokerage' } });
    fireEvent.click(screen.getByText('Answer'));
    expect(answer).toHaveBeenCalledWith('Brokerage');
  });
});
