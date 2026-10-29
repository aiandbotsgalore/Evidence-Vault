import React, { useState } from 'react';
import { Sparkles, X, Check, Copy, Filter } from 'lucide-react';
import { AskVaultResponse } from '../types';

interface AskVaultBannerProps {
  result: AskVaultResponse;
  isFilteringByResult: boolean;
  onToggleFilterByResult: () => void;
  onClearResult: () => void;
  onSelectEntity?: (entity: string) => void;
}

/**
 * Renders the synthesized Gemini 4 Argon answer and converts any inline
 * `[Speaker Coordinate "Quote"]` brackets into one-click copyable citation buttons.
 */
export const AskVaultBanner: React.FC<AskVaultBannerProps> = ({
  result,
  isFilteringByResult,
  onToggleFilterByResult,
  onClearResult,
  onSelectEntity,
}) => {
  const [copiedCitation, setCopiedCitation] = useState<string | null>(null);

  const handleCopyInlineCitation = async (citation: string) => {
    try {
      await navigator.clipboard.writeText(citation);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = citation;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopiedCitation(citation);
    setTimeout(() => setCopiedCitation(null), 1800);
  };

  // Split synthesis text by `[... "..."]` citation tags so each tag is interactive
  const parts = result.synthesis.split(/(\[[^\[\]]+?\s+"[^"]+"\])/g);

  return (
    <section className="mb-6 rounded-lg border border-amber-500/40 bg-[#131C2E] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 text-xs text-amber-300 font-medium">
          <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
          <span>Argon Thematic Synthesis</span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span className="text-slate-300 font-normal">
            Query: &ldquo;{result.query}&rdquo;
          </span>
          <span aria-hidden="true" className="text-slate-600">
            ·
          </span>
          <span className="font-mono tabular-nums text-slate-400">
            {result.matched_chunk_ids.length} cited chunks
          </span>
        </div>

        <div className="flex items-center gap-2">
          {result.matched_chunk_ids.length > 0 && (
            <button
              type="button"
              onClick={onToggleFilterByResult}
              className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                isFilteringByResult
                  ? 'bg-amber-500/20 border-amber-500/60 text-amber-200'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white'
              }`}
            >
              <Filter className="w-3 h-3" />
              <span>
                {isFilteringByResult
                  ? `Showing ${result.matched_chunk_ids.length} Cited Cards`
                  : 'Show All Vault Cards'}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={onClearResult}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-slate-400 hover:text-white rounded-md hover:bg-slate-800/80 transition-colors cursor-pointer whitespace-nowrap"
          >
            <X className="w-3.5 h-3.5" />
            <span>Dismiss</span>
          </button>
        </div>
      </div>

      {/* Synthesized Narrative with Clickable Citation Pills */}
      <div className="text-sm text-slate-100 leading-relaxed space-y-2">
        <p className="leading-7">
          {parts.map((part, idx) => {
            if (/^\[[^\[\]]+?\s+"[^"]+"\]$/.test(part)) {
              const isCopied = copiedCitation === part;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleCopyInlineCitation(part)}
                  className={`inline-flex items-center gap-1.5 mx-1 px-2 py-0.5 font-mono text-xs rounded border transition-colors cursor-pointer align-baseline ${
                    isCopied
                      ? 'bg-emerald-950/70 border-emerald-500/60 text-emerald-200'
                      : 'bg-[#0B0F17] border-amber-500/40 text-amber-300 hover:border-amber-400'
                  }`}
                  title="Click to copy exact citation tag"
                >
                  <span>{part}</span>
                  {isCopied ? (
                    <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                  ) : (
                    <Copy className="w-3 h-3 text-amber-400/80 shrink-0" />
                  )}
                </button>
              );
            }
            return <span key={idx}>{part}</span>;
          })}
        </p>
      </div>

      {result.key_entities && result.key_entities.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          <span className="text-slate-500">Key thematic entities:</span>
          {result.key_entities.map((ent, idx) => (
            <React.Fragment key={ent}>
              {idx > 0 && <span aria-hidden="true">·</span>}
              <button
                type="button"
                onClick={() => onSelectEntity?.(ent)}
                className="text-slate-300 hover:text-amber-300 hover:underline cursor-pointer"
                title={`Filter vault by entity: ${ent}`}
              >
                {ent}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </section>
  );
};
