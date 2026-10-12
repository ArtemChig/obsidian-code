// Error boundary so one broken view never blanks the whole app. Owner: ui-foundation.
import { TriangleAlert, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@renderer/components/ui/button';

interface Props {
  children: ReactNode;
  /** Shown in the fallback ("Chat", "GPU view"…). */
  area?: string;
  /** Changing this resets the boundary (e.g. the session id). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null };
    return null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] ${this.props.area ?? 'view'} crashed`, error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="flex max-w-[520px] flex-col items-center gap-3 text-center">
          <TriangleAlert size={18} aria-hidden className="text-err" />
          <div className="text-[13.5px] font-semibold tracking-[-0.022em] text-t1">{this.props.area ?? 'This view'} hit an error</div>
          <pre className="ob-selectable max-h-40 w-full overflow-auto rounded-[2px] border border-err-wash bg-s1 p-3 text-left font-mono text-[11px] text-err shadow-[inset_2px_0_0_var(--err)]">
            {this.state.error.message}
          </pre>
          <Button icon={RotateCcw} onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
}
