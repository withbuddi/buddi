/**
 * The controls on an approval — the owner's own settings on an effect they are
 * about to authorize (docs/email.md §4, docs/architecture.md "Actions and
 * approvals").
 *
 * The rule the whole boundary rests on is unchanged and is why this is a
 * `<select>` rather than a field: **what is approved is what is shown.** Every
 * option here came from the action the server recorded before anybody was
 * asked, the default is preselected so doing nothing sends what the preview
 * says, and the server checks the answer against that same declared list. A
 * control that let the owner type a value would be offering something the
 * preview never described.
 *
 * It is drawn above the buttons on purpose: it changes what Approve means, and
 * a setting read after the decision is a setting nobody made.
 */
import { useState } from 'react';
import type { OwnerChoiceRow } from '../../api';
import { Field } from '../../ui';

/** The defaults, as a map — what a decision sends when nothing is touched. */
export function defaultChoices(choices: readonly OwnerChoiceRow[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const choice of choices ?? []) out[choice.key] = choice.default;
  return out;
}

/**
 * One select per declared choice, and the map they currently say.
 *
 * A hook rather than a component with a callback, because both cards need the
 * same two things — something to draw, and something to send with the
 * decision — and splitting them would let one be drawn without the other being
 * sent.
 */
export function useOwnerChoices(choices: readonly OwnerChoiceRow[] | undefined): {
  /**
   * What to send with the decision — and `undefined`, not `{}`, when the action
   * declared nothing. An approval that offered no choices must go out as the
   * request it always was.
   */
  values: Record<string, string> | undefined;
  controls: JSX.Element | null;
} {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const declared = choices ?? [];
  const values = { ...defaultChoices(declared), ...picked };
  if (declared.length === 0) return { values: undefined, controls: null };
  return {
    values,
    controls: (
      <div className="ui-choices">
        {declared.map((choice) => (
          <Field key={choice.key} label={choice.label} inline>
            <select
              value={values[choice.key]}
              onChange={(event) =>
                setPicked((current) => ({ ...current, [choice.key]: event.target.value }))
              }
            >
              {choice.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
    ),
  };
}
