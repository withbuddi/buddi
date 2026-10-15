/**
 * A part of the page that failed to load or draw stays that part's problem.
 *
 * A lazy chunk that rejects (the editor, a viewer) throws where it renders;
 * without a boundary that reaches the root and the whole dashboard goes. Here
 * it stops: the shell and everything beside the part stay, and so does any
 * unsaved text the part's owner keeps outside it. The failure is a hint first
 * (`confirmUpdate`): a new build reloads, or with something in progress leaves
 * the avatar's "Reload to update"; otherwise a small line offers Retry.
 */
import { Component, type ReactNode } from 'react';
import { Button, Notice } from '../ui';
import { confirmUpdate } from './freshness';

export interface LoadBoundaryProps {
  /** What failed, as the line says it: "the editor", "the preview". */
  what: string;
  /** Called before the part is drawn again: a lazy component makes a fresh import here, since React keeps a rejected one. */
  onRetry?: () => void;
  /** Said under the line: "Your changes are kept." */
  note?: ReactNode;
  children: ReactNode;
}

interface State {
  failed: boolean;
  /** The gateway serves a newer build: the failure is the update. */
  updated: boolean;
}

export class LoadBoundary extends Component<LoadBoundaryProps, State> {
  override state: State = { failed: false, updated: false };
  private alive = true;

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  override componentDidCatch(): void {
    void confirmUpdate().then((updated) => { if (this.alive && updated) this.setState({ updated: true }); });
  }

  override componentDidMount(): void {
    this.alive = true;
  }

  override componentWillUnmount(): void {
    this.alive = false;
  }

  private retry = (): void => {
    this.props.onRetry?.();
    this.setState({ failed: false, updated: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { what, note } = this.props;
    if (this.state.updated) {
      return (
        <Notice role="status">
          buddi was updated. Reload the page to load {what}.{note ? <> {note}</> : null}
        </Notice>
      );
    }
    return (
      <Notice tone="warning" role="alert" action={<Button size="sm" onClick={this.retry}>Retry</Button>}>
        Could not load {what}.{note ? <> {note}</> : null}
      </Notice>
    );
  }
}
