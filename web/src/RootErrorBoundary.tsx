import { Component, type ErrorInfo, type ReactNode } from 'react';

export class RootErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; message: string; stack?: string }
> {
  state = { hasError: false, message: '', stack: undefined as string | undefined };

  static getDerivedStateFromError(err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { hasError: true, message: e.message || String(e), stack: e.stack };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    console.error('[web] root_render_error', err, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-100">
        <div className="mx-auto max-w-3xl px-5 py-10">
          <div className="rounded-2xl border border-zinc-800/60 bg-zinc-900/30 p-6 shadow-lg shadow-black/30">
            <div className="text-lg font-semibold tracking-tight">UI crashed during render</div>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">
              This is a client-side error boundary so you get a useful screen instead of a blank page. Check the browser
              console for details.
            </p>
            <div className="mt-4 rounded-xl border border-red-900/30 bg-red-950/20 p-3 font-mono text-xs text-red-200/90">
              {this.state.message}
            </div>
            {this.state.stack ? (
              <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-zinc-800/60 bg-black/30 p-3 text-[11px] leading-relaxed text-zinc-300">
                {this.state.stack}
              </pre>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => this.setState({ hasError: false, message: '', stack: undefined })}
                className="rounded-xl border border-zinc-600/70 bg-zinc-800/80 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-700/80"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-xl bg-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-950/40 hover:bg-indigo-400"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}

