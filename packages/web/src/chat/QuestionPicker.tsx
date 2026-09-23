import { useEffect, useState } from 'react';
import { Button } from '../ui';
import type { ChatQuestion } from './types';

export function QuestionPicker({
  question,
  disabled,
  onAnswer,
  onSkip,
}: {
  question: ChatQuestion;
  disabled: boolean;
  onAnswer: (answer: string, optionId?: string) => void;
  /** Close the question without an answer; the agent goes on by itself. */
  onSkip: () => void;
}): JSX.Element {
  const [other, setOther] = useState('');
  // Esc skips, from anywhere on the page, while the question is showing.
  useEffect(() => {
    if (disabled) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onSkip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [disabled, onSkip]);
  return (
    <section className="wb-question" aria-label="Question from agent" data-testid="question-picker">
      <div className="wb-question-head">
        <span className="wb-question-kicker">Needs your input</span>
        <Button
          className="wb-question-skip"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onSkip}
          title="Skip this question (Esc). The agent carries on without an answer."
        >
          Skip
        </Button>
        <strong>{question.question}</strong>
      </div>
      {question.options.length > 0 ? (
        <div className="wb-question-options">
          {question.options.map((option, index) => (
            <button
              key={option.id}
              className="wb-question-option"
              data-recommended={option.recommended || undefined}
              disabled={disabled}
              onClick={() => onAnswer(option.label, option.id)}
            >
              <span className="wb-question-number">{index + 1}</span>
              <span>
                <span className="wb-question-label">
                  {option.label}{option.recommended ? <em>Recommended</em> : null}
                </span>
                {option.hint ? <small>{option.hint}</small> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {question.allowOther ? (
        <form
          className="wb-question-other"
          onSubmit={(event) => {
            event.preventDefault();
            if (other.trim()) onAnswer(other.trim());
          }}
        >
          <input
            value={other}
            onChange={(event) => setOther(event.target.value)}
            placeholder={question.options.length ? 'Something else…' : 'Type your answer…'}
            disabled={disabled}
          />
          <button className="ui-btn" data-variant="accent" disabled={disabled || !other.trim()}>
            Answer
          </button>
        </form>
      ) : null}
      <p className="wb-question-note">This answers a question. It does not approve an action. Esc skips it.</p>
    </section>
  );
}
