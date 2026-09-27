/**
 * `/` anywhere: to the page's composer, or home to the one there.
 *
 * A page has at most one composer (Home's, the chat's), found by its field's
 * id. Typing a `/` into a field is typing, never a shortcut, and a chord with
 * a modifier belongs to the browser. A composer that is there but hidden or
 * shut (the Listening panel, a send in flight) keeps its page: the key does
 * nothing rather than carry the owner off somewhere else.
 */
import { useEffect } from 'react';
import { COMPOSER_INPUT_ID } from '../chat/Composer';
import { HOME_ROUTE } from '../routes';

/** Whether a key pressed here is typing: a field, a select, anything editable. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

export function useSlashToComposer(navigate: (route: string) => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      const box = document.getElementById(COMPOSER_INPUT_ID);
      if (box instanceof HTMLTextAreaElement) {
        if (!box.disabled && !box.hidden) box.focus();
        return;
      }
      navigate(HOME_ROUTE);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, enabled]);
}
