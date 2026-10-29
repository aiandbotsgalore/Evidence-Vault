import React, { useState, useRef, useMemo } from 'react';
import {
  X,
  Upload,
  FileText,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import {
  ArgonChunkEnrichment,
  ClassificationType,
  EvidenceChunk,
  RawDeterministicChunk,
  SourceDocument,
  SourceType,
} from '../types';
import {
  buildCitationPill,
  detectIsAudioClipCatalog,
  detectIsTranscript,
  deterministicFallbackClassify,
  parseAudioClipCatalogDeterministically,
  parseDocumentDeterministically,
  parseTranscriptDeterministically,
} from '../utils/parser';
import { getAccessToken, googleSignIn } from '../auth';
import {
  DriveFileItem,
  downloadDriveFileContent,
  listTargetFolderFiles,
  TARGET_DRIVE_FOLDER_ID,
  TARGET_DRIVE_FOLDER_URL,
} from '../utils/drive';
import {
  JsonlImportResult,
  detectIsJsonlCorpus,
  importCorpusFromJsonl,
} from '../utils/exporters';

interface IngestionDrawerProps {
  isOpen: boolean;
  initialFile?: { name: string; content: string } | null;
  onClose: () => void;
  onIngestComplete: (
    newSource: SourceDocument,
    newChunks: EvidenceChunk[]
  ) => void;
  onJsonlImported?: (result: JsonlImportResult) => Promise<void> | void;
}

const VALID_CLASSIFICATIONS = new Set<ClassificationType>([
  'verified_record',
  'spoken_statement',
  'allegation_or_claim',
  'editorial_note',
]);

function inferMetadataFromFilename(
  fileName: string,
  content: string
): {
  title: string;
  sourceType: SourceType;
  defaultSpeaker: string;
} {
  const baseName = fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

  const titleCase = baseName
    ? baseName.replace(/\b\w/g, (l) => l.toUpperCase())
    : 'Untitled Evidence Source';

  const isClipCatalog = detectIsAudioClipCatalog(content);
  const isTranscript = detectIsTranscript(fileName, content);
  const lower = (fileName + ' ' + content.slice(0, 400)).toLowerCase();

  let sourceType: SourceType =
    isClipCatalog || isTranscript ? 'archival_audio' : 'court_filing';

  if (lower.includes('interview') || lower.includes('deposition')) {
    sourceType = 'witness_interview';
  } else if (
    !isClipCatalog &&
    (lower.includes('note') ||
      lower.includes('todo') ||
      lower.includes('editorial'))
  ) {
    sourceType = 'editorial_note';
  } else if (
    !isClipCatalog &&
    (lower.includes('filing') ||
      lower.includes('docket') ||
      lower.includes('exhibit') ||
      lower.includes('petition') ||
      lower.includes('stipulat'))
  ) {
    sourceType = 'court_filing';
  }

  let defaultSpeaker = 'Speaker';

  if (isClipCatalog) {
    // Find the most frequent valid speaker from `SPEAKER:` lines to use when an entry says "Not specified"
    const speakerRegex = /^\s*SPEAKER\s*:\s*(.+)$/gim;
    const counts = new Map<string, number>();
    let match: RegExpExecArray | null;
    while ((match = speakerRegex.exec(content)) !== null) {
      const candidate = match[1].trim();
      if (
        candidate &&
        !/^(?:not\s+specified|unspecified|unknown|n\/a|none|-+)$/i.test(
          candidate
        )
      ) {
        counts.set(candidate, (counts.get(candidate) || 0) + 1);
      }
    }

    let topSpeaker = '';
    let topCount = 0;
    for (const [spk, cnt] of counts.entries()) {
      if (cnt > topCount) {
        topSpeaker = spk;
        topCount = cnt;
      }
    }

    if (topSpeaker) {
      defaultSpeaker = topSpeaker;
    } else if (/angela/i.test(fileName)) {
      defaultSpeaker = 'Angela Maggard';
    } else {
      defaultSpeaker = titleCase.split(' ').slice(0, 2).join(' ') || 'Host';
    }
  } else if (sourceType === 'court_filing') {
    defaultSpeaker = titleCase.startsWith('Doc:')
      ? titleCase
      : `Doc: ${titleCase.slice(0, 24)}`;
  } else if (sourceType === 'editorial_note') {
    defaultSpeaker = 'Note: Producer';
  } else {
    // Try to detect first speaker in transcript
    const vttMatch = content.match(/<v\s+([^>]+)>/i);
    const bracketMatch = content.match(/\[([A-Za-z0-9\s.'-]{2,30})\]:/);
    const colonMatch = content.match(/^([A-Z][A-Za-z\s.'-]{2,28}):\s+/m);
    if (vttMatch) defaultSpeaker = vttMatch[1].trim();
    else if (bracketMatch) defaultSpeaker = bracketMatch[1].trim();
    else if (colonMatch) defaultSpeaker = colonMatch[1].trim();
    else defaultSpeaker = titleCase.slice(0, 28);
  }

  return {
    title: titleCase,
    sourceType,
    defaultSpeaker,
  };
}

export const IngestionDrawer: React.FC<IngestionDrawerProps> = ({
  isOpen,
  initialFile,
  onClose,
  onIngestComplete,
  onJsonlImported,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [fileName, setFileName] = useState<string>(
    initialFile?.name || ''
  );
  const [rawContent, setRawContent] = useState<string>(
    initialFile?.content || ''
  );
  const [title, setTitle] = useState<string>(() =>
    initialFile
      ? inferMetadataFromFilename(initialFile.name, initialFile.content).title
      : ''
  );
  const [sourceType, setSourceType] = useState<SourceType>(() =>
    initialFile
      ? inferMetadataFromFilename(initialFile.name, initialFile.content)
          .sourceType
      : 'archival_audio'
  );
  const [defaultSpeaker, setDefaultSpeaker] = useState<string>(() =>
    initialFile
      ? inferMetadataFromFilename(initialFile.name, initialFile.content)
          .defaultSpeaker
      : ''
  );

  // Sync state when a new file is dropped from the main workspace
  React.useEffect(() => {
    if (initialFile) {
      const inferred = inferMetadataFromFilename(
        initialFile.name,
        initialFile.content
      );
      setFileName(initialFile.name);
      setRawContent(initialFile.content);
      setTitle(inferred.title);
      setSourceType(inferred.sourceType);
      setDefaultSpeaker(inferred.defaultSpeaker);
      setErrorMsg(null);
    }
  }, [initialFile]);

  // Batch processing progress state (30 chunks ceiling per request)
  const [isEnriching, setIsEnriching] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    currentBatch: number;
    totalBatches: number;
    processedChunks: number;
    totalChunks: number;
    statusNote: string;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Google Drive Browser state
  const [isDriveBrowserOpen, setIsDriveBrowserOpen] = useState(false);
  const [driveFiles, setDriveFiles] = useState<
    { id: string; name: string; mimeType: string; modifiedTime?: string }[]
  >([]);
  const [driveSearch, setDriveSearch] = useState('');
  const [isLoadingDrive, setIsLoadingDrive] = useState(false);
  const [downloadingDriveId, setDownloadingDriveId] = useState<string | null>(
    null
  );

  const sourceIdPreview = useMemo(() => {
    const slug = (title || 'source')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 24);
    return `src_${slug}_${Date.now().toString(36).slice(-4)}`;
  }, [title]);

  const detectedParserMode = useMemo<
    'jsonl_corpus' | 'audio_clip_catalog' | 'transcript' | 'document'
  >(() => {
    if (detectIsJsonlCorpus(fileName, rawContent)) return 'jsonl_corpus';
    if (detectIsAudioClipCatalog(rawContent)) return 'audio_clip_catalog';
    if (detectIsTranscript(fileName, rawContent, sourceType))
      return 'transcript';
    return 'document';
  }, [rawContent, fileName, sourceType]);

  // Live deterministic chunk preview before calling Gemini 4 Argon
  const deterministicChunks: RawDeterministicChunk[] = useMemo(() => {
    if (!rawContent.trim()) return [];
    const effectiveTitle = title.trim() || 'Untitled Source';
    const effectiveSpeaker =
      defaultSpeaker.trim() ||
      (sourceType === 'court_filing' ? 'Doc: Filing' : 'Speaker');

    if (detectedParserMode === 'jsonl_corpus') {
      const lines = rawContent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const previewItems: RawDeterministicChunk[] = [];
      for (let i = 0; i < lines.length; i++) {
        try {
          const obj = JSON.parse(lines[i]);
          const spk = obj.speaker || effectiveSpeaker;
          const coord = obj.coordinate || obj.timestamp || `#${i + 1}`;
          const txt = obj.text || obj.quote_snippet || '';
          const { quote_snippet, citation_pill } = buildCitationPill(
            spk,
            coord,
            txt,
            obj.quote_snippet || txt
          );
          previewItems.push({
            chunk_id:
              obj.chunk_id ||
              `chk_${sourceIdPreview}_${String(i + 1).padStart(3, '0')}`,
            source_id: obj.source_id || sourceIdPreview,
            source_title: obj.source_title || effectiveTitle,
            source_type: obj.source_type || sourceType,
            speaker: spk,
            coordinate: coord,
            start_ms: typeof obj.start_ms === 'number' ? obj.start_ms : null,
            end_ms: typeof obj.end_ms === 'number' ? obj.end_ms : null,
            page_or_section: obj.page_or_section || coord,
            text: txt,
            default_quote_snippet: quote_snippet,
            default_citation_pill: obj.citation_pill || citation_pill,
          });
        } catch {
          // Invalid lines will be caught and reported with exact line number on import
        }
      }
      return previewItems;
    }

    if (detectedParserMode === 'audio_clip_catalog') {
      return parseAudioClipCatalogDeterministically(
        rawContent,
        sourceIdPreview,
        effectiveTitle,
        sourceType,
        effectiveSpeaker
      );
    }

    if (detectedParserMode === 'transcript') {
      return parseTranscriptDeterministically(
        rawContent,
        sourceIdPreview,
        effectiveTitle,
        sourceType,
        effectiveSpeaker
      );
    }
    return parseDocumentDeterministically(
      rawContent,
      sourceIdPreview,
      effectiveTitle,
      sourceType,
      effectiveSpeaker
    );
  }, [
    rawContent,
    title,
    sourceType,
    defaultSpeaker,
    sourceIdPreview,
    detectedParserMode,
  ]);

  if (!isOpen) return null;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const inferred = inferMetadataFromFilename(file.name, text);
    setFileName(file.name);
    setRawContent(text);
    setTitle(inferred.title);
    setSourceType(inferred.sourceType);
    setDefaultSpeaker(inferred.defaultSpeaker);
    setErrorMsg(null);
  };

  const handleBrowseDrive = async () => {
    setErrorMsg(null);
    setIsLoadingDrive(true);
    try {
      let token = await getAccessToken();
      if (!token) {
        const signInResult = await googleSignIn();
        token = signInResult?.accessToken || null;
      }
      if (!token) {
        throw new Error('Please sign in with Google to access the target folder.');
      }

      setIsDriveBrowserOpen(true);
      const files = await listTargetFolderFiles();
      setDriveFiles(files);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Failed to load files from target Google Drive folder.'
      );
    } finally {
      setIsLoadingDrive(false);
    }
  };

  const handleSelectDriveFile = async (file: DriveFileItem) => {
    setErrorMsg(null);
    setDownloadingDriveId(file.id);
    try {
      const downloaded = await downloadDriveFileContent(file);
      const inferred = inferMetadataFromFilename(
        downloaded.name,
        downloaded.content
      );
      setFileName(downloaded.name);
      setRawContent(downloaded.content);
      setTitle(inferred.title);
      setSourceType(inferred.sourceType);
      setDefaultSpeaker(inferred.defaultSpeaker);
      setIsDriveBrowserOpen(false);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Failed to download file from Google Drive.'
      );
    } finally {
      setDownloadingDriveId(null);
    }
  };

  /**
   * Executes direct JSONL line-by-line import (if JSONL corpus) OR sequential 30-chunk
   * batch enrichment via `gemini-4-argon` (`/api/enrich-chunks`).
   */
  const handleConfirmAndEnrich = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rawContent.trim()) {
      setErrorMsg('Please provide valid transcript, JSONL, or document content.');
      return;
    }

    setIsEnriching(true);
    setErrorMsg(null);

    if (detectedParserMode === 'jsonl_corpus') {
      try {
        const result = await importCorpusFromJsonl(
          rawContent,
          fileName || `${title || 'corpus'}.jsonl`
        );
        if (onJsonlImported) {
          await onJsonlImported(result);
        }
        onClose();
      } catch (err: unknown) {
        setErrorMsg(
          err instanceof Error ? err.message : 'JSONL Corpus import failed.'
        );
      } finally {
        setIsEnriching(false);
      }
      return;
    }

    if (deterministicChunks.length === 0) {
      setIsEnriching(false);
      setErrorMsg('Please provide valid transcript or document content to parse.');
      return;
    }

    const BATCH_SIZE = 30;
    const totalChunks = deterministicChunks.length;
    const totalBatches = Math.ceil(totalChunks / BATCH_SIZE);
    const enrichedChunks: EvidenceChunk[] = [];

    try {
      for (let b = 0; b < totalBatches; b++) {
        const startIdx = b * BATCH_SIZE;
        const batchSlice = deterministicChunks.slice(
          startIdx,
          startIdx + BATCH_SIZE
        );

        setBatchProgress({
          currentBatch: b + 1,
          totalBatches,
          processedChunks: startIdx,
          totalChunks,
          statusNote: `Running Gemini 4 Argon semantic pass on batch ${b + 1} of ${totalBatches} (${batchSlice.length} chunks)...`,
        });

        let batchEnrichmentsMap = new Map<string, ArgonChunkEnrichment>();

        try {
          const response = await fetch('/api/enrich-chunks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sourceTitle: title.trim() || 'Untitled Source',
              sourceType,
              chunks: batchSlice.map((c) => ({
                chunk_id: c.chunk_id,
                speaker: c.speaker,
                coordinate: c.coordinate,
                text: c.text,
              })),
            }),
          });

          if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data.items)) {
              for (const item of data.items as ArgonChunkEnrichment[]) {
                if (item && item.chunk_id) {
                  batchEnrichmentsMap.set(item.chunk_id, item);
                }
              }
            }
          }
        } catch {
          // If network or API key unavailable, falls back cleanly to deterministic classifier per chunk
        }

        for (const rawChunk of batchSlice) {
          const llmResult = batchEnrichmentsMap.get(rawChunk.chunk_id);
          const fallback = deterministicFallbackClassify(rawChunk);

          const classification: ClassificationType =
            llmResult && VALID_CLASSIFICATIONS.has(llmResult.classification)
              ? llmResult.classification
              : fallback.classification;

          const summary =
            llmResult?.summary && llmResult.summary.trim().length > 8
              ? llmResult.summary.trim()
              : fallback.summary;

          const named_entities =
            llmResult?.named_entities &&
            Array.isArray(llmResult.named_entities) &&
            llmResult.named_entities.length > 0
              ? llmResult.named_entities.slice(0, 6)
              : fallback.named_entities;

          // For Audio Clip Catalog mode, preserve the exact QUOTE: field as the quote_snippet
          // while still running verbatim validation and inner single-quote sanitization.
          const preferredSnippet =
            detectedParserMode === 'audio_clip_catalog'
              ? rawChunk.text
              : llmResult?.quote_snippet;

          const { quote_snippet, citation_pill } = buildCitationPill(
            rawChunk.speaker,
            rawChunk.coordinate,
            rawChunk.text,
            preferredSnippet
          );

          enrichedChunks.push({
            chunk_id: rawChunk.chunk_id,
            source_id: rawChunk.source_id,
            source_title: rawChunk.source_title,
            source_type: rawChunk.source_type,
            speaker: rawChunk.speaker,
            coordinate: rawChunk.coordinate,
            start_ms: rawChunk.start_ms,
            end_ms: rawChunk.end_ms,
            page_or_section: rawChunk.page_or_section,
            text: rawChunk.text,
            quote_snippet,
            citation_pill,
            classification,
            summary,
            named_entities,
            is_sample: false,
          });
        }

        setBatchProgress({
          currentBatch: b + 1,
          totalBatches,
          processedChunks: Math.min(startIdx + batchSlice.length, totalChunks),
          totalChunks,
          statusNote: `Completed batch ${b + 1} of ${totalBatches}.`,
        });
      }

      const newSource: SourceDocument = {
        source_id: sourceIdPreview,
        title: title.trim() || 'Untitled Source',
        source_type: sourceType,
        default_speaker:
          defaultSpeaker.trim() ||
          (sourceType === 'court_filing' ? 'Doc: Filing' : 'Speaker'),
        file_name: fileName || 'pasted_document.txt',
        ingested_at: new Date().toISOString(),
        chunk_count: enrichedChunks.length,
        is_sample: false,
      };

      onIngestComplete(newSource, enrichedChunks);
      onClose();
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to ingest source.'
      );
    } finally {
      setIsEnriching(false);
      setBatchProgress(null);
    }
  };

  const progressPercentage = batchProgress
    ? Math.round(
        (batchProgress.processedChunks /
          Math.max(1, batchProgress.totalChunks)) *
          100
      )
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/75 backdrop-blur-xs">
      <div className="relative w-full max-w-2xl bg-[#0E1420] border-l border-slate-800 h-full flex flex-col justify-between overflow-hidden">
        {/* Drawer Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-white font-display">
              Ingest & Classify Evidence Source
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Deterministic VTT/SRT, Audio Clip Catalog & legal clause parser + sequential 30-chunk Gemini 4 Argon enrichment
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isEnriching}
            className="p-2 text-slate-400 hover:text-white rounded-md hover:bg-slate-800/60 transition-colors cursor-pointer"
            aria-label="Close drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drawer Body */}
        <form
          onSubmit={handleConfirmAndEnrich}
          className="flex-1 overflow-y-auto px-6 py-5 space-y-5"
        >
          {/* File Upload & Google Drive Import */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-slate-300">
                1. Select Local File (.vtt, .srt, .txt, .md) or Load from Drive Folder
              </label>
              <button
                type="button"
                onClick={() => handleBrowseDrive()}
                disabled={isLoadingDrive}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-md transition-colors cursor-pointer whitespace-nowrap"
              >
                {isLoadingDrive ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FileText className="w-3.5 h-3.5" />
                )}
                <span>Target Drive Folder</span>
              </button>
            </div>

            {isDriveBrowserOpen && (
              <div className="mb-3 p-3.5 rounded-lg border border-amber-500/40 bg-[#0B0F17] space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="text-xs font-semibold text-white block truncate">
                      Target Folder Files ({TARGET_DRIVE_FOLDER_ID.slice(0, 12)}...)
                    </span>
                    <a
                      href={TARGET_DRIVE_FOLDER_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-amber-400 hover:underline block"
                    >
                      Open folder in Google Drive ↗
                    </a>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDriveBrowserOpen(false)}
                    className="text-xs text-slate-400 hover:text-white cursor-pointer"
                  >
                    Close
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={driveSearch}
                    onChange={(e) => setDriveSearch(e.target.value)}
                    placeholder="Filter files by name in target folder..."
                    className="flex-1 px-2.5 py-1.5 text-xs bg-[#121926] border border-slate-800 rounded text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
                  />
                  {driveSearch && (
                    <button
                      type="button"
                      onClick={() => setDriveSearch('')}
                      className="px-2 py-1 text-xs text-slate-400 hover:text-white cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="max-h-44 overflow-y-auto divide-y divide-slate-800/80 border border-slate-800/80 rounded">
                  {isLoadingDrive ? (
                    <div className="p-4 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                      <span>Loading target Drive folder files...</span>
                    </div>
                  ) : driveFiles.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-500">
                      No files found in target folder {TARGET_DRIVE_FOLDER_ID}.
                    </div>
                  ) : (
                    driveFiles
                      .filter((df) =>
                        !driveSearch.trim() ||
                        df.name.toLowerCase().includes(driveSearch.toLowerCase())
                      )
                      .map((df) => (
                        <div
                          key={df.id}
                          className="flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-slate-800/40"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-slate-200 truncate font-mono">
                              {df.name}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {df.mimeType ===
                              'application/vnd.google-apps.document'
                                ? 'Google Doc'
                                : df.mimeType}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={downloadingDriveId === df.id}
                            onClick={() => handleSelectDriveFile(df)}
                            className="px-2.5 py-1 text-xs font-medium text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded transition-colors cursor-pointer shrink-0"
                          >
                            {downloadingDriveId === df.id
                              ? 'Loading...'
                              : 'Load File'}
                          </button>
                        </div>
                      ))
                  )}
                </div>
              </div>
            )}

            <div
              onClick={() => fileInputRef.current?.click()}
              className="border border-dashed border-slate-700 hover:border-amber-500/60 bg-[#0B0F17] rounded-lg p-4 text-center cursor-pointer transition-colors"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".jsonl,.vtt,.srt,.txt,.md,application/json,text/plain,text/vtt,text/markdown"
                onChange={handleFileChange}
                className="hidden"
              />
              <div className="flex items-center justify-center gap-2.5 text-xs text-slate-300">
                <Upload className="w-4 h-4 text-amber-400 shrink-0" />
                <span>
                  {fileName ? (
                    <>
                      Loaded file:{' '}
                      <strong className="text-white font-mono">
                        {fileName}
                      </strong>{' '}
                      (click to replace)
                    </>
                  ) : (
                    'Click to browse or drop a JSONL Corpus (.jsonl), WebVTT, SRT, Audio Clip Catalog (.txt), or Markdown file'
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Source Metadata Confirmation Fields */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Source Title
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Enter source title..."
                className="w-full px-3 py-2 text-xs bg-[#0B0F17] border border-slate-800 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Source Type
              </label>
              <select
                value={sourceType}
                onChange={(e) => setSourceType(e.target.value as SourceType)}
                className="w-full px-3 py-2 text-xs bg-[#0B0F17] border border-slate-800 rounded-md text-white focus:outline-none focus:border-amber-500"
              >
                <option value="archival_audio">archival_audio</option>
                <option value="court_filing">court_filing</option>
                <option value="witness_interview">witness_interview</option>
                <option value="editorial_note">editorial_note</option>
              </select>
            </div>

            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Default Speaker / Prefix
              </label>
              <input
                type="text"
                required
                value={defaultSpeaker}
                onChange={(e) => setDefaultSpeaker(e.target.value)}
                placeholder="Default speaker or document prefix..."
                className="w-full px-3 py-2 text-xs bg-[#0B0F17] border border-slate-800 rounded-md text-white placeholder-slate-500 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>

          {/* Raw Text Content Editor / Inspector */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-300">
                Raw Source Content (Editable before chunking)
              </label>
              <span className="text-[11px] font-mono tabular-nums text-slate-400">
                {rawContent.length.toLocaleString()} chars ·{' '}
                {detectedParserMode === 'jsonl_corpus'
                  ? 'Mode: JSONL Corpus Direct Import (IndexedDB Bulk Insert)'
                  : detectedParserMode === 'audio_clip_catalog'
                  ? 'Mode: Audio Clip Catalog (1 chunk per # entry)'
                  : detectedParserMode === 'transcript'
                  ? 'Mode: Timestamped Transcript (30–60s turns)'
                  : 'Mode: Written Document (Clause / Page split)'}
              </span>
            </div>
            <textarea
              rows={6}
              value={rawContent}
              onChange={(e) => setRawContent(e.target.value)}
              placeholder="Paste WebVTT, SRT, Audio Clip Catalog (#001 / SPEAKER: / TIMESTAMP: / QUOTE:), or legal document paragraphs here..."
              className="w-full px-3 py-2.5 text-xs font-mono bg-[#0B0F17] border border-slate-800 rounded-md text-slate-200 placeholder-slate-600 focus:outline-none focus:border-amber-500 leading-relaxed"
            />
          </div>

          {/* Live Deterministic Chunking & Sanitized Citation Preview */}
          <div className="border border-slate-800 rounded-lg bg-[#0B0F17] p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
                <FileText className="w-3.5 h-3.5 text-amber-400" />
                <span>Deterministic Parser Preview</span>
              </div>
              <span className="text-xs font-mono tabular-nums text-amber-400">
                {deterministicChunks.length} chunks ready (
                {Math.max(1, Math.ceil(deterministicChunks.length / 30))} batch
                {Math.ceil(deterministicChunks.length / 30) === 1 ? '' : 'es'} of
                ≤30)
              </span>
            </div>

            {deterministicChunks.length === 0 ? (
              <p className="text-xs text-slate-500 py-3 text-center">
                Drop a file or paste text above to preview deterministic chunks and sanitized citation pills.
              </p>
            ) : (
              <div className="space-y-2.5 max-h-52 overflow-y-auto pr-1">
                {deterministicChunks.slice(0, 8).map((chk, index) => (
                  <div
                    key={chk.chunk_id}
                    className="p-2.5 rounded border border-slate-800/90 bg-[#121926] text-xs"
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 mb-1">
                      <span className="font-mono text-slate-300">
                        #{index + 1} · {chk.speaker} · {chk.coordinate}
                      </span>
                      <span className="font-mono tabular-nums text-slate-500">
                        {chk.page_or_section}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-amber-300/95 mb-1 truncate">
                      {chk.default_citation_pill}
                    </div>
                    <p className="text-slate-400 line-clamp-2 leading-relaxed">
                      {chk.text}
                    </p>
                  </div>
                ))}
                {deterministicChunks.length > 8 && (
                  <p className="text-[11px] text-slate-500 text-center pt-1">
                    + {deterministicChunks.length - 8} additional chunks will be processed in sequential batches of 30.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Sequential Batch Progress Bar (30 chunks per request ceiling) */}
          {batchProgress && (
            <div className="p-4 rounded-lg border border-amber-500/40 bg-amber-950/20 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-amber-300 flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>{batchProgress.statusNote}</span>
                </span>
                <span className="font-mono tabular-nums text-amber-200">
                  Batch {batchProgress.currentBatch}/{batchProgress.totalBatches}{' '}
                  · {batchProgress.processedChunks}/{batchProgress.totalChunks}{' '}
                  chunks ({progressPercentage}%)
                </span>
              </div>
              <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-amber-500 transition-transform duration-200 origin-left"
                  style={{
                    transform: `scaleX(${Math.max(0.05, progressPercentage / 100)})`,
                  }}
                />
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 rounded-md border border-red-500/40 bg-red-950/30 text-xs text-red-300 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Drawer Footer */}
          <div className="pt-3 border-t border-slate-800 flex items-center justify-between gap-4">
            <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>
                Inner double quotes sanitized to single quotes; verbatim substring verified
              </span>
            </div>

            <div className="flex items-center gap-2.5 shrink-0">
              <button
                type="button"
                onClick={onClose}
                disabled={isEnriching}
                className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-700 rounded-md transition-colors cursor-pointer whitespace-nowrap"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isEnriching || deterministicChunks.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 rounded-md transition-colors cursor-pointer whitespace-nowrap"
              >
                {isEnriching ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Enriching Chunks...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>
                      Confirm & Enrich ({deterministicChunks.length} Chunks)
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
