import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { db } from '../db';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Evidence Vault UI Error Caught by ErrorBoundary:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleResetIndexedDB = async () => {
    if (
      window.confirm(
        'Are you sure you want to reset IndexedDB local storage? This will clear locally indexed sources and chunks if storage was corrupted.'
      )
    ) {
      try {
        await db.delete();
        window.location.reload();
      } catch (err) {
        console.error('Failed to reset DB:', err);
        window.location.reload();
      }
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-[#121926] border border-amber-500/40 rounded-xl p-6 sm:p-8 shadow-2xl">
            <div className="flex items-center gap-3 text-amber-400 mb-4">
              <AlertTriangle className="w-6 h-6 shrink-0" />
              <h2 className="text-lg font-bold font-display text-white">
                Evidence Vault Workspace Recovery
              </h2>
            </div>

            <p className="text-xs sm:text-sm text-slate-300 mb-4 leading-relaxed">
              A rendering issue was detected. Your underlying IndexedDB storage is preserved. You can reload the application workbench or reset local cache below.
            </p>

            {this.state.error && (
              <div className="mb-6 p-3 bg-[#0B0F17] rounded-md border border-slate-800 text-[11px] font-mono text-red-300/90 break-words max-h-36 overflow-y-auto">
                {this.state.error.message || String(this.state.error)}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={this.handleReload}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reload Workbench</span>
              </button>

              <button
                type="button"
                onClick={this.handleResetIndexedDB}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-red-300 hover:text-white bg-red-950/40 hover:bg-red-900/60 border border-red-500/30 rounded-lg transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Reset Corrupted Storage</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
