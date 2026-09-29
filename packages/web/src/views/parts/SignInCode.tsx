/**
 * A sign-in code the owner types somewhere else: shown in a field that selects
 * itself on focus, with a Copy button beside it. Used by the ChatGPT card in
 * first run and by the account page in Settings, so the code looks the same in
 * both places.
 */
import { useState } from 'react';
import { Button, Field, Toolbar } from '../../ui';

export function SignInCode({ code, label = 'Your code', large = false }: { code: string; label?: string; large?: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
    } catch {
      /* A browser that refuses the clipboard leaves the code on screen to select. */
    }
  };
  return (
    <Toolbar valign="end">
      <Field label={label} grow>
        <input readOnly value={code} data-code={large ? 'large' : undefined} spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
      </Field>
      <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
    </Toolbar>
  );
}
