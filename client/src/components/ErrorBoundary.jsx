import { Component } from 'react';

// Catches render crashes in the wrapped subtree and shows a recoverable
// error card instead of blank-screening the entire app (which previously
// required a full page refresh to recover from).
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Keep the crash visible in devtools for debugging
    console.error('ErrorBoundary caught:', error, info?.componentStack);
  }
  render() {
    const { error } = this.state;
    const { fallbackLabel, children } = this.props;
    if (error) {
      return (
        <div className="p-6 max-w-2xl mx-auto">
          <div className="card p-8 text-center">
            <div className="text-4xl mb-3">⚠️</div>
            <h2 className="text-lg font-bold text-slate-800 mb-1">Something went wrong</h2>
            <p className="text-sm text-slate-500 mb-1">
              {fallbackLabel || 'This section'} ran into a problem and couldn't be displayed.
            </p>
            <p className="text-xs text-slate-400 mb-5">Your work is safe — nothing was lost.</p>
            <div className="flex justify-center gap-2">
              <button
                className="btn btn-primary btn-sm"
                onClick={() => this.setState({ error: null })}
              >
                Try again
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => window.location.reload()}
              >
                Reload app
              </button>
            </div>
          </div>
        </div>
      );
    }
    return children;
  }
}
