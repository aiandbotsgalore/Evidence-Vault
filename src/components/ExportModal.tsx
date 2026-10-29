import React, { useState } from 'react';
import {
  X,
  Download,
  Film,
  FileText,
  FileJson,
  Loader2,
  CheckCircle2,
  HardDrive,
  Layers,
  Sparkles,
} from 'lucide-react';
import type { ClassificationType, SourceDocument } from '../types';
import {
  streamExportJsonl,
  streamExportNleCutList,
  streamExportStructuredBrief,
  StreamProgress,
} from '../utils/streamingExport';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  sources: SourceDocument[];
  totalChunkCount: number;
  selectedSourceId: string;
  selectedClassification: ClassificationType | 'all';
}

type ExportType = 'brief' | 'edl' | 'jsonl';

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  sources,
  totalChunkCount,
  selectedSourceId,
  selectedClassification,
}) => {
  const [exportType, setExportType] = useState<ExportType>('brief');
  const [filterBySource, setFilterBySource] = useState<string>(selectedSourceId);
  const [filterByClassification, setFilterByClassification] =
    useState<ClassificationType | 'all'>(selectedClassification);
  const [fps, setFps] = useState<number>(24);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [progress, setProgress] = useState<StreamProgress | null>(null);
  const [exportComplete, setExportComplete] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleStartExport = async () => {
    setIsExporting(true);
    setExportComplete(false);
    setProgress({
      processedChunks: 0,
      totalChunks: totalChunkCount,
      percent: 0,
      stage: 'Initializing stream serialization pipeline...',
    });

    try {
      if (exportType === 'brief') {
        await streamExportStructuredBrief(
          {
            sourceId: filterBySource,
            classification: filterByClassification,
          },
          (p) => setProgress(p)
        );
      } else if (exportType === 'edl') {
        await streamExportNleCutList(
          {
            sourceId: filterBySource,
            classification: filterByClassification,
            fps,
          },
          (p) => setProgress(p)
        );
      } else if (exportType === 'jsonl') {
        await streamExportJsonl((p) => setProgress(p));
      }
      setExportComplete(true);
    } catch (err: unknown) {
      console.error('Streaming export failed:', err);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
      <div className="w-full max-w-xl bg-[#0E131F] border border-slate-800 rounded-xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-[#121926]">
          <div className="flex items-center gap-2.5">
            <Download className="w-5 h-5 text-amber-400" />
            <div>
              <h2 className="text-sm font-bold text-white font-display">
                Streamed Documentary Dossier Builder & Media Packaging
              </h2>
              <p className="text-[11px] text-slate-400">
                Zero-lag streamed serialization via ReadableStream & chunked writers
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="text-slate-400 hover:text-white cursor-pointer disabled:opacity-40"
            aria-label="Close export modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5">
          {/* Export Format Selector */}
          <div>
            <label className="block text-xs font-semibold text-slate-300 font-display mb-2">
              Select Documentary Packaging Format
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Option 1: Structured Evidence Brief */}
              <button
                type="button"
                onClick={() => setExportType('brief')}
                className={`flex flex-col p-3 rounded-lg border text-left cursor-pointer transition-all ${
                  exportType === 'brief'
                    ? 'border-amber-500 bg-amber-500/10 text-white ring-1 ring-amber-500/50'
                    : 'border-slate-800 bg-[#141D2E] text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <FileText
                    className={`w-4 h-4 ${
                      exportType === 'brief' ? 'text-amber-400' : 'text-slate-400'
                    }`}
                  />
                  <span className="text-xs font-semibold text-white">
                    Evidence Brief
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-tight">
                  Structured Markdown dossier grouped by entity with verbatim citations.
                </p>
              </button>

              {/* Option 2: NLE Cut List EDL */}
              <button
                type="button"
                onClick={() => setExportType('edl')}
                className={`flex flex-col p-3 rounded-lg border text-left cursor-pointer transition-all ${
                  exportType === 'edl'
                    ? 'border-amber-500 bg-amber-500/10 text-white ring-1 ring-amber-500/50'
                    : 'border-slate-800 bg-[#141D2E] text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Film
                    className={`w-4 h-4 ${
                      exportType === 'edl' ? 'text-amber-400' : 'text-slate-400'
                    }`}
                  />
                  <span className="text-xs font-semibold text-white">
                    NLE Cut List (EDL)
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-tight">
                  CMX 3600 standard for Premiere, DaVinci Resolve, and Final Cut.
                </p>
              </button>

              {/* Option 3: Corpus JSONL */}
              <button
                type="button"
                onClick={() => setExportType('jsonl')}
                className={`flex flex-col p-3 rounded-lg border text-left cursor-pointer transition-all ${
                  exportType === 'jsonl'
                    ? 'border-amber-500 bg-amber-500/10 text-white ring-1 ring-amber-500/50'
                    : 'border-slate-800 bg-[#141D2E] text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <FileJson
                    className={`w-4 h-4 ${
                      exportType === 'jsonl' ? 'text-amber-400' : 'text-slate-400'
                    }`}
                  />
                  <span className="text-xs font-semibold text-white">
                    Corpus (JSONL)
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-tight">
                  Streamed raw JSON lines for machine ingestion and pipelines.
                </p>
              </button>
            </div>
          </div>

          {/* Filtering Options (for Brief and EDL) */}
          {exportType !== 'jsonl' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-800">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Scope Source
                </label>
                <select
                  value={filterBySource}
                  onChange={(e) => setFilterBySource(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-[#141D2E] border border-slate-800 rounded-md text-white focus:outline-none focus:border-amber-500"
                >
                  <option value="all">All Sources ({sources.length} files)</option>
                  {sources.map((s) => (
                    <option key={s.source_id} value={s.source_id}>
                      {s.title} ({s.chunk_count} chunks)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Classification Scope
                </label>
                <select
                  value={filterByClassification}
                  onChange={(e) =>
                    setFilterByClassification(
                      e.target.value as ClassificationType | 'all'
                    )
                  }
                  className="w-full px-3 py-2 text-xs bg-[#141D2E] border border-slate-800 rounded-md text-white focus:outline-none focus:border-amber-500"
                >
                  <option value="all">All Classifications</option>
                  <option value="verified_record">Verified Records Only</option>
                  <option value="spoken_statement">Spoken Statements Only</option>
                  <option value="allegation_or_claim">Allegations & Claims Only</option>
                  <option value="editorial_note">Editorial Notes Only</option>
                </select>
              </div>

              {exportType === 'edl' && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Timeline Frame Rate (FPS)
                  </label>
                  <select
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                    className="w-full px-3 py-2 text-xs bg-[#141D2E] border border-slate-800 rounded-md text-white focus:outline-none focus:border-amber-500"
                  >
                    <option value={24}>24 fps (Cinema / Documentary)</option>
                    <option value={25}>25 fps (PAL / European Broadcast)</option>
                    <option value={30}>29.97 / 30 fps (NTSC / US Broadcast)</option>
                    <option value={60}>60 fps (High Frame Rate)</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Live Streaming Progress Meter */}
          {progress && (
            <div className="p-3.5 rounded-lg border border-slate-800 bg-[#121926] space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-amber-300 font-semibold flex items-center gap-1.5">
                  {isExporting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {exportComplete && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  )}
                  <span>
                    {exportComplete
                      ? 'Stream Export Completed Successfully'
                      : progress.stage}
                  </span>
                </span>
                <span className="font-mono text-slate-300 font-medium">
                  {progress.percent}%
                </span>
              </div>

              <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-amber-500 transition-all duration-150"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>

              <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono">
                <span>
                  Chunks processed: {progress.processedChunks} / {progress.totalChunks}
                </span>
                <span>Direct stream serialization</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-800 bg-[#121926]">
          <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-slate-500" />
            <span>Reads directly from IndexedDB without main-thread blocking</span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              disabled={isExporting}
              className="px-3.5 py-2 text-xs font-medium text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-md transition-colors cursor-pointer disabled:opacity-40"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleStartExport}
              disabled={isExporting || totalChunkCount === 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-md transition-colors cursor-pointer shadow-xs"
            >
              {isExporting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Streaming File...</span>
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5" />
                  <span>Start Streamed Export</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
