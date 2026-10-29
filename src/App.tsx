/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { User } from 'firebase/auth';
import {
  Search,
  Sparkles,
  Upload,
  Download,
  FileJson,
  FileText,
  Trash2,
  FolderOpen,
  X,
  Loader2,
  FileCheck2,
  MessageSquareQuote,
  AlertTriangle,
  StickyNote,
  Check,
  LogOut,
  Tag,
  Hash,
  ChevronLeft,
  ChevronRight,
  Film,
  Zap,
  Cpu,
  Layers,
} from 'lucide-react';
import {
  db,
  getAllCustomTagsWithCounts,
  getClassificationCounts,
  queryVaultChunks,
} from './db';
import { initAuth, googleSignIn, logout } from './auth';
import {
  AskVaultResponse,
  ClassificationType,
  EvidenceChunk,
  SourceDocument,
} from './types';
import {
  EvidenceCard,
  SOURCE_TYPE_LABELS,
} from './components/EvidenceCard';
import { VirtualEvidenceList } from './components/VirtualEvidenceList';
import { ExportModal } from './components/ExportModal';
import { IngestionDrawer } from './components/IngestionDrawer';
import { AskVaultBanner } from './components/AskVaultBanner';
import { useSearchWorker } from './hooks/useSearchWorker';
import {
  detectIsJsonlCorpus,
  exportCorpusAsJsonl,
  exportEvidenceMapAsMarkdown,
  importCorpusFromJsonl,
  JsonlImportResult,
} from './utils/exporters';
import {
  streamExportJsonl,
  streamExportNleCutList,
  streamExportStructuredBrief,
} from './utils/streamingExport';
import {
  TARGET_DRIVE_FOLDER_ID,
  TARGET_DRIVE_FOLDER_URL,
  scanAndIngestDriveFolder,
  skipCurrentScanningFile,
  ScanFolderProgress,
} from './utils/drive';

const CLASSIFICATION_FILTERS: {
  id: ClassificationType | 'all';
  label: string;
  shortLabel: string;
  Icon?: React.ComponentType<{ className?: string }>;
  colorClass: string;
}[] = [
  {
    id: 'all',
    label: 'All Evidence',
    shortLabel: 'All Evidence',
    colorClass: 'text-slate-200',
  },
  {
    id: 'verified_record',
    label: 'Verified Record',
    shortLabel: 'Verified Records',
    Icon: FileCheck2,
    colorClass: 'text-emerald-400',
  },
  {
    id: 'spoken_statement',
    label: 'Spoken Statement',
    shortLabel: 'Statements',
    Icon: MessageSquareQuote,
    colorClass: 'text-sky-400',
  },
  {
    id: 'allegation_or_claim',
    label: 'Allegation / Claim',
    shortLabel: 'Allegations',
    Icon: AlertTriangle,
    colorClass: 'text-amber-400',
  },
  {
    id: 'editorial_note',
    label: 'Editorial Note',
    shortLabel: 'Editorial Notes',
    Icon: StickyNote,
    colorClass: 'text-violet-400',
  },
];

export const PAGE_SIZE = 30;

function generatePaginationRange(
  current: number,
  total: number
): (number | '...')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, '...', total];
  }
  if (current >= total - 3) {
    return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, '...', current - 1, current, current + 1, '...', total];
}

/**
 * Local fallback synthesis if `/api/ask-vault` is offline or unconfigured.
 */
function buildLocalFallbackSynthesis(
  query: string,
  chunks: EvidenceChunk[]
): AskVaultResponse {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const scored = chunks
    .map((c) => {
      const hay = `${c.text} ${c.summary} ${c.speaker} ${c.source_title} ${c.named_entities.join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (hay.includes(term)) score += 2;
      }
      if (c.classification === 'verified_record') score += 0.5;
      return { chunk: c, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const topMatches =
    scored.length > 0
      ? scored.slice(0, 4).map((s) => s.chunk)
      : chunks.slice(0, 3);

  const verified = topMatches.filter(
    (c) => c.classification === 'verified_record'
  );
  const claims = topMatches.filter(
    (c) => c.classification === 'allegation_or_claim'
  );
  const others = topMatches.filter(
    (c) =>
      c.classification !== 'verified_record' &&
      c.classification !== 'allegation_or_claim'
  );

  const sentences: string[] = [];
  if (verified.length > 0) {
    sentences.push(
      `Verified documentary records establish that ${verified[0].summary.replace(/\.$/, '')} ${verified[0].citation_pill}.`
    );
  }
  if (claims.length > 0) {
    sentences.push(
      `By contrast, contested testimony alleges that ${claims[0].summary.replace(/\.$/, '')} ${claims[0].citation_pill}.`
    );
  }
  if (others.length > 0) {
    sentences.push(
      `Additional context from ${others[0].speaker} notes: ${others[0].summary.replace(/\.$/, '')} ${others[0].citation_pill}.`
    );
  }

  const entities = Array.from(
    new Set(topMatches.flatMap((c) => c.named_entities))
  ).slice(0, 6);

  return {
    query,
    synthesis:
      sentences.join(' ') ||
      `Matched ${topMatches.length} evidence records across the vault for "${query}".`,
    matched_chunk_ids: topMatches.map((c) => c.chunk_id),
    key_entities: entities,
    used_model: 'local-synthesis',
  };
}

export default function App() {
  // Google Workspace / Drive Auth state
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState<boolean>(true);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // Google Drive Target Folder Scanning state
  const [isScanningFolder, setIsScanningFolder] = useState<boolean>(false);
  const [folderScanProgress, setFolderScanProgress] =
    useState<ScanFolderProgress | null>(null);
  const [folderScanBanner, setFolderScanBanner] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // Reactive state backed by Dexie IndexedDB (`EvidenceVaultDB`)
  const [sources, setSources] = useState<SourceDocument[]>([]);
  const [filteredChunks, setFilteredChunks] = useState<EvidenceChunk[]>([]);
  const [totalChunkCount, setTotalChunkCount] = useState<number>(0);
  const [totalFilteredCount, setTotalFilteredCount] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [classificationCounts, setClassificationCounts] = useState<
    Record<ClassificationType | 'all', number>
  >({
    all: 0,
    verified_record: 0,
    spoken_statement: 0,
    allegation_or_claim: 0,
    editorial_note: 0,
  });
  const [isLoadingDB, setIsLoadingDB] = useState<boolean>(true);

  // Filtering state
  const [selectedSourceId, setSelectedSourceId] = useState<string>('all');
  const [selectedClassification, setSelectedClassification] = useState<
    ClassificationType | 'all'
  >('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<{ tag: string; count: number }[]>([]);

  // Web Worker-offloaded FlexSearch state & controls
  const {
    isWorkerReady,
    isSearching: isWorkerSearching,
    searchDurationMs,
    totalIndexed: workerTotalIndexed,
    syncCorpusToWorker,
    addChunksToWorker,
    clearWorkerIndex,
    executeWorkerSearch,
  } = useSearchWorker();

  const [workerMatchIds, setWorkerMatchIds] = useState<string[] | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);

  // 250ms debounce on search input to prevent re-querying on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
      setCurrentPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Offload debounced search query execution to Web Worker FlexSearch index
  useEffect(() => {
    let isCancelled = false;
    const query = debouncedSearchQuery.trim();

    if (query) {
      executeWorkerSearch(query, {
        sourceId: selectedSourceId,
        classification: selectedClassification,
        tag: selectedTag,
      }).then((matchIds) => {
        if (!isCancelled) {
          setWorkerMatchIds(matchIds);
          setTotalFilteredCount(matchIds.length);
        }
      });
    } else {
      setWorkerMatchIds(null);
    }

    return () => {
      isCancelled = true;
    };
  }, [
    debouncedSearchQuery,
    selectedSourceId,
    selectedClassification,
    selectedTag,
    executeWorkerSearch,
  ]);

  // Ask Vault (Argon) thematic retrieval state
  const [isAskingVault, setIsAskingVault] = useState<boolean>(false);
  const [askVaultResult, setAskVaultResult] =
    useState<AskVaultResponse | null>(null);
  const [filterByAskResult, setFilterByAskResult] = useState<boolean>(true);

  // Ingestion Drawer & Global Drag-and-Drop state
  const jsonlFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [isIngestionOpen, setIsIngestionOpen] = useState<boolean>(false);
  const [droppedFile, setDroppedFile] = useState<{
    name: string;
    content: string;
  } | null>(null);
  const [isDraggingOverWindow, setIsDraggingOverWindow] =
    useState<boolean>(false);
  const [confirmClearAll, setConfirmClearAll] = useState<boolean>(false);

  // Import status banner / toast state (shows exact "Import failed on line X: [reason]" or success count)
  const [importBanner, setImportBanner] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser, accessToken) => {
        setUser(authedUser);
        setToken(accessToken);
        setNeedsAuth(false);
      },
      () => {
        setUser(null);
        setToken(null);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setToken(result.accessToken);
        setNeedsAuth(false);
      }
    } catch (err) {
      console.error('Google Sign-In failed:', err);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogout = async () => {
    await logout();
    setUser(null);
    setToken(null);
    setNeedsAuth(true);
  };

  // Tracks continuation checkpoint for small batch jobs (15 files per job)
  const [nextJobStartIndex, setNextJobStartIndex] = useState<number>(0);

  /**
   * Asynchronously queries Dexie (`db.sources` and `db.chunks`) to refresh
   * the catalog, classification counters, and filtered chunk feed.
   * Accepts an optional `overrideSourceId` so newly imported/ingested sources
   * render immediately without waiting for a second render cycle.
   */
  /**
   * Asynchronously queries Dexie (`db.sources` and `db.chunks`) to refresh
   * the catalog, classification counters, and active 30-chunk page slice.
   * All filtering, counting, and pagination are offloaded directly to IndexedDB.
   */
  const refreshVaultFromDexie = useCallback(
    async (overrideSourceId?: string, targetPage?: number) => {
      try {
        const effectiveSourceId =
          overrideSourceId !== undefined ? overrideSourceId : selectedSourceId;
        const pageToLoad = targetPage !== undefined ? targetPage : currentPage;

        const [loadedSources, totalCount, counts, tagCounts] = await Promise.all([
          db.sources.toArray(),
          db.chunks.count(),
          getClassificationCounts(effectiveSourceId),
          getAllCustomTagsWithCounts(),
        ]);

        // Sort sources newest first
        loadedSources.sort((a, b) =>
          (b.ingested_at || '').localeCompare(a.ingested_at || '')
        );
        setSources(loadedSources);
        setTotalChunkCount(totalCount);
        setClassificationCounts(counts);
        setAvailableTags(tagCounts);

        // Sync IndexedDB chunks to Web Worker FlexSearch index
        db.chunks.toArray().then((allChunks) => {
          syncCorpusToWorker(allChunks);
        });

        // Offload indexed query, counting, and active 30-item slice to Dexie
        const queryResult = await queryVaultChunks({
          sourceId: effectiveSourceId,
          classification: selectedClassification,
          tag: selectedTag,
          searchQuery: debouncedSearchQuery,
          matchedChunkIds:
            askVaultResult && filterByAskResult
              ? askVaultResult.matched_chunk_ids
              : null,
          page: pageToLoad,
          pageSize: PAGE_SIZE,
        });

        setFilteredChunks(queryResult.chunks);
        if (!workerMatchIds && !debouncedSearchQuery.trim()) {
          setTotalFilteredCount(queryResult.totalFilteredCount);
        }
      } catch (err) {
        console.error('Dexie refresh error:', err);
      } finally {
        setIsLoadingDB(false);
      }
    },
    [
      selectedSourceId,
      selectedClassification,
      selectedTag,
      debouncedSearchQuery,
      askVaultResult,
      filterByAskResult,
      currentPage,
      syncCorpusToWorker,
      workerMatchIds,
    ]
  );

  const handleSelectEntity = useCallback((entity: string) => {
    setAskVaultResult(null);
    setSearchQuery(entity);
    setDebouncedSearchQuery(entity);
    setCurrentPage(1);
  }, []);

  const handleSelectSource = useCallback((sourceId: string) => {
    setSelectedSourceId((prev) => (prev === sourceId ? 'all' : sourceId));
    setCurrentPage(1);
  }, []);

  const handleSelectClassification = useCallback(
    (cls: ClassificationType | 'all') => {
      setSelectedClassification(cls);
      setCurrentPage(1);
    },
    []
  );

  const handleSelectTag = useCallback((tag: string) => {
    setSelectedTag((prev) => (prev === tag ? null : tag));
    setCurrentPage(1);
  }, []);

  const handleTagsChanged = useCallback(async () => {
    await refreshVaultFromDexie();
  }, [refreshVaultFromDexie]);

  const scanAbortControllerRef = React.useRef<AbortController | null>(null);

  /**
   * Scans and ingests files from the target Google Drive folder in small jobs of 15 files,
   * inserting each file live into Dexie and triggering immediate UI feed refresh as it's parsed.
   */
  const handleScanTargetDriveFolder = async (
    startIndex = 0,
    runAllSequentially = true
  ) => {
    setFolderScanBanner(null);
    setIsScanningFolder(true);
    const abortController = new AbortController();
    scanAbortControllerRef.current = abortController;

    try {
      let currentToken = token;
      if (!currentToken || needsAuth) {
        const signInResult = await googleSignIn();
        if (signInResult) {
          setUser(signInResult.user);
          setToken(signInResult.accessToken);
          setNeedsAuth(false);
          currentToken = signInResult.accessToken;
        }
      }
      if (!currentToken) {
        throw new Error(
          'Please sign in with Google to allow Evidence Vault to scan the target folder.'
        );
      }

      const result = await scanAndIngestDriveFolder({
        startIndex,
        maxFilesPerJob: 15,
        runAllJobsSequentially: runAllSequentially,
        skipAlreadyIngested: startIndex === 0,
        signal: abortController.signal,
        onProgress: (progress) => {
          setFolderScanProgress(progress);
        },
        onFileIngested: async () => {
          // Immediately refresh Dexie data into the view as each file is finished!
          await refreshVaultFromDexie();
        },
      });

      if (result.nextStartIndex !== undefined && result.nextStartIndex !== null) {
        setNextJobStartIndex(result.nextStartIndex);
      } else {
        setNextJobStartIndex(0);
      }

      await refreshVaultFromDexie('all');
      setSelectedSourceId('all');
      setSelectedClassification('all');

      if (result.ingestedChunksCount > 0) {
        setFolderScanBanner({
          type: 'success',
          message: `Ingested ${result.ingestedChunksCount} chunks across ${
            result.ingestedSourcesCount
          } source file${result.ingestedSourcesCount === 1 ? '' : 's'}. Live feed updated.`,
        });
      } else {
        setFolderScanBanner({
          type: 'error',
          message:
            result.skippedFiles.length > 0
              ? `Small job finished. Skipped files: ${result.skippedFiles.slice(0, 5).join(', ')}${
                  result.skippedFiles.length > 5 ? ` (+${result.skippedFiles.length - 5} more)` : ''
                }`
              : 'Small job complete: No new files to ingest.',
        });
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed scanning target Google Drive folder.';
      setFolderScanBanner({
        type: 'error',
        message: msg,
      });
    } finally {
      setIsScanningFolder(false);
      setFolderScanProgress(null);
      scanAbortControllerRef.current = null;
    }
  };

  const handleStopScan = () => {
    if (scanAbortControllerRef.current) {
      scanAbortControllerRef.current.abort();
    }
  };

  useEffect(() => {
    refreshVaultFromDexie();
  }, [refreshVaultFromDexie]);

  /**
   * Handles direct JSONL Corpus file import into Dexie `sources` and `chunks` tables,
   * immediately reloading state and displaying a toast/banner on success or line-level failure.
   */
  const handleDirectJsonlImport = async (
    fileName: string,
    rawContent: string
  ) => {
    setImportBanner(null);
    try {
      const result = await importCorpusFromJsonl(rawContent, fileName);
      const targetSource =
        result.importedSourcesCount === 1 && result.firstSourceId
          ? result.firstSourceId
          : 'all';
      setSelectedSourceId(targetSource);
      setSelectedClassification('all');
      setSearchQuery('');
      setAskVaultResult(null);
      await refreshVaultFromDexie(targetSource);
      setImportBanner({
        type: 'success',
        message: `Imported ${result.importedChunksCount} chunks across ${result.importedSourcesCount} source${
          result.importedSourcesCount === 1 ? '' : 's'
        } into IndexedDB.`,
      });
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Import failed on line 1: Unknown JSONL parsing error';
      console.warn('JSONL Corpus Import Error:', msg);
      setImportBanner({
        type: 'error',
        message: msg,
      });
    }
  };

  const handleJsonlFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    e.target.value = '';
    await handleDirectJsonlImport(file.name, text);
  };

  // Global window drag-and-drop handlers
  const handleWindowDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingOverWindow) {
      setIsDraggingOverWindow(true);
    }
  };

  const handleWindowDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDraggingOverWindow(false);
  };

  const handleWindowDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOverWindow(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    const text = await file.text();
    // If dropped file is a JSONL corpus (.jsonl or valid JSONL lines), import directly into Dexie!
    if (detectIsJsonlCorpus(file.name, text)) {
      await handleDirectJsonlImport(file.name, text);
      return;
    }

    setDroppedFile({ name: file.name, content: text });
    setIsIngestionOpen(true);
  };

  /**
   * Writes newly ingested source and chunks asynchronously to Dexie `EvidenceVaultDB`.
   */
  const handleIngestComplete = async (
    newSource: SourceDocument,
    newChunks: EvidenceChunk[]
  ) => {
    await db.transaction('rw', db.sources, db.chunks, async () => {
      await db.sources.put(newSource);
      await db.chunks.bulkPut(newChunks);
    });
    setSelectedSourceId(newSource.source_id);
    setSelectedClassification('all');
    setDroppedFile(null);
    await refreshVaultFromDexie(newSource.source_id);
    setImportBanner({
      type: 'success',
      message: `Ingested "${newSource.title}" (${newChunks.length} chunks) into IndexedDB.`,
    });
  };

  const handleDrawerJsonlImported = async (result: JsonlImportResult) => {
    const targetSource =
      result.importedSourcesCount === 1 && result.firstSourceId
        ? result.firstSourceId
        : 'all';
    setSelectedSourceId(targetSource);
    setSelectedClassification('all');
    setSearchQuery('');
    setAskVaultResult(null);
    await refreshVaultFromDexie(targetSource);
    setImportBanner({
      type: 'success',
      message: `Imported ${result.importedChunksCount} chunks across ${result.importedSourcesCount} source${
        result.importedSourcesCount === 1 ? '' : 's'
      } into IndexedDB.`,
    });
  };

  /**
   * Asynchronously clears any records flagged `is_sample: true` from Dexie
   */
  const hasSampleData = useMemo(
    () => sources.some((s) => Boolean(s.is_sample)),
    [sources]
  );

  const handleClearSampleData = async () => {
    await db.transaction('rw', db.sources, db.chunks, async () => {
      const sampleSourceIds = await db.sources
        .filter((s) => Boolean(s.is_sample))
        .primaryKeys();
      const sampleChunkIds = await db.chunks
        .filter((c) => Boolean(c.is_sample))
        .primaryKeys();

      if (sampleSourceIds.length > 0) {
        await db.sources.bulkDelete(sampleSourceIds);
      }
      if (sampleChunkIds.length > 0) {
        await db.chunks.bulkDelete(sampleChunkIds);
      }
    });
    await refreshVaultFromDexie();
  };

  const handleClearVault = async () => {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      setTimeout(() => setConfirmClearAll(false), 3500);
      return;
    }
    await db.transaction('rw', db.sources, db.chunks, async () => {
      await db.sources.clear();
      await db.chunks.clear();
    });
    setSelectedSourceId('all');
    setSelectedClassification('all');
    setSearchQuery('');
    setAskVaultResult(null);
    setConfirmClearAll(false);
    await refreshVaultFromDexie();
  };

  const handleDeleteSource = async (
    sourceId: string,
    e: React.MouseEvent
  ) => {
    e.stopPropagation();
    await db.transaction('rw', db.sources, db.chunks, async () => {
      await db.sources.delete(sourceId);
      await db.chunks.where('source_id').equals(sourceId).delete();
    });
    if (selectedSourceId === sourceId) {
      setSelectedSourceId('all');
    }
    await refreshVaultFromDexie();
  };

  /**
   * Thematic query handler for "Ask Vault (Argon)" reading chunks directly from Dexie
   */
  const handleAskVault = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;

    setIsAskingVault(true);
    try {
      const allChunksInVault = await db.chunks.toArray();
      if (allChunksInVault.length === 0) return;

      const response = await fetch('/api/ask-vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: trimmed,
          chunks: allChunksInVault,
        }),
      });

      if (response.ok) {
        const data: AskVaultResponse = await response.json();
        setAskVaultResult(data);
        setFilterByAskResult(true);
      } else {
        const fallback = buildLocalFallbackSynthesis(
          trimmed,
          allChunksInVault
        );
        setAskVaultResult(fallback);
        setFilterByAskResult(true);
      }
    } catch {
      const allChunksInVault = await db.chunks.toArray();
      const fallback = buildLocalFallbackSynthesis(trimmed, allChunksInVault);
      setAskVaultResult(fallback);
      setFilterByAskResult(true);
    } finally {
      setIsAskingVault(false);
    }
  };



  const activeSourceObj = useMemo(
    () => sources.find((s) => s.source_id === selectedSourceId) || null,
    [sources, selectedSourceId]
  );

  const totalPages = Math.max(1, Math.ceil(totalFilteredCount / PAGE_SIZE));

  return (
    <div
      onDragOver={handleWindowDragOver}
      onDragLeave={handleWindowDragLeave}
      onDrop={handleWindowDrop}
      className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col selection:bg-amber-500/30 selection:text-amber-200"
    >
      {/* Full-Window Drag-and-Drop Overlay */}
      {isDraggingOverWindow && (
        <div className="fixed inset-0 z-50 bg-[#0B0F17]/90 backdrop-blur-xs border-2 border-dashed border-amber-500 m-4 rounded-xl flex flex-col items-center justify-center pointer-events-none">
          <Upload className="w-10 h-10 text-amber-400 mb-3" />
          <p className="text-lg font-semibold text-white font-display">
            Drop Transcript, Audio Clip Catalog, or Document to Ingest
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Supports WebVTT (.vtt), SubRip (.srt), Audio Clip Catalogs (.txt), and Markdown (.md)
          </p>
        </div>
      )}

      {/* TOP BAR CONTRACT: Strictly 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-8 px-6 py-3.5 bg-[#0B0F17]/95 backdrop-blur-xs border-b border-slate-800/90">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setSelectedSourceId('all');
            setSelectedClassification('all');
            setSelectedTag(null);
            setSearchQuery('');
            setAskVaultResult(null);
          }}
          className="text-base font-bold tracking-tight text-white font-display whitespace-nowrap shrink-0"
        >
          Evidence Vault
        </a>

        {/* Zone 2: 5 concise single-line text navigation links for instant classification filtering */}
        <nav
          aria-label="Evidence classification filter"
          className="hidden md:flex items-center gap-6 text-xs font-medium text-slate-400"
        >
          {CLASSIFICATION_FILTERS.map((tab) => {
            const isActive = selectedClassification === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleSelectClassification(tab.id)}
                className={`transition-colors whitespace-nowrap shrink-0 cursor-pointer py-1 border-b-2 ${
                  isActive
                    ? 'text-white border-amber-500 font-semibold'
                    : 'text-slate-400 border-transparent hover:text-slate-200'
                }`}
              >
                {tab.shortLabel}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={() => {
              setDroppedFile(null);
              setIsIngestionOpen(true);
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 shrink-0" />
            <span>Ingest Source</span>
          </button>
        </div>
      </header>

      {/* MAIN WORKBENCH BODY: Left Rail (290px) + Center Canvas */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-[1600px] w-full mx-auto">
        {/* LEFT RAIL: Sources Catalog, Verification Tag Filters, Google Drive & Export Actions */}
        <aside className="w-full lg:w-[290px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800/90 bg-[#0E131F] p-5 flex flex-col justify-between gap-6">
          <div className="space-y-6">
            {/* Section 1: Sources Catalog */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-xs font-semibold text-slate-300 font-display">
                  Sources Catalog
                </h2>
                <span className="text-xs font-mono tabular-nums text-slate-500">
                  {sources.length} files · {totalChunkCount} chunks
                </span>
              </div>

              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => handleSelectSource('all')}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs transition-colors cursor-pointer ${
                    selectedSourceId === 'all'
                      ? 'bg-slate-800/90 text-white font-medium'
                      : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                  }`}
                >
                  <span className="truncate">All Ingested Sources</span>
                  <span className="font-mono tabular-nums text-[11px] text-slate-400 ml-2 shrink-0">
                    {totalChunkCount}
                  </span>
                </button>

                {sources.length === 0 ? (
                  <p className="text-[11px] text-slate-500 px-3 py-2">
                    No files ingested yet. Drop a file or click Ingest Source.
                  </p>
                ) : (
                  sources.map((src) => {
                    const isSelected = selectedSourceId === src.source_id;

                    return (
                      <div
                        key={src.source_id}
                        onClick={() => handleSelectSource(src.source_id)}
                        className={`group flex items-center justify-between px-3 py-2 rounded-md text-xs transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-slate-800/90 text-white font-medium'
                            : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                        }`}
                      >
                        <div className="min-w-0 flex-1 pr-2">
                          <div className="truncate text-slate-200">
                            {src.title}
                          </div>
                          <div className="text-[11px] text-slate-500 truncate mt-0.5">
                            {SOURCE_TYPE_LABELS[src.source_type]} ·{' '}
                            {src.default_speaker}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="font-mono tabular-nums text-[11px] text-slate-400">
                            {src.chunk_count}
                          </span>
                          <button
                            type="button"
                            onClick={(e) =>
                              handleDeleteSource(src.source_id, e)
                            }
                            className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-red-400 transition-opacity cursor-pointer"
                            title={`Remove ${src.title}`}
                            aria-label={`Remove ${src.title}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Section 2: Verification & Classification Filter */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-xs font-semibold text-slate-300 font-display">
                  Classification Filter
                </h2>
                {selectedClassification !== 'all' && (
                  <button
                    type="button"
                    onClick={() => handleSelectClassification('all')}
                    className="text-[11px] text-amber-400 hover:underline cursor-pointer"
                  >
                    Reset
                  </button>
                )}
              </div>

              <div className="space-y-1">
                {CLASSIFICATION_FILTERS.map((item) => {
                  const active = selectedClassification === item.id;
                  const count = classificationCounts[item.id];
                  const IconComponent = item.Icon;

                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectClassification(item.id)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs transition-colors cursor-pointer ${
                        active
                          ? 'bg-slate-800/90 text-white font-medium'
                          : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2 truncate">
                        {IconComponent && (
                          <IconComponent
                            className={`w-3.5 h-3.5 shrink-0 ${item.colorClass}`}
                          />
                        )}
                        <span className={active ? 'text-white' : item.colorClass}>
                          {item.label}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums text-[11px] text-slate-400">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Section 2.5: Custom Metadata Tags (#) */}
            <div className="pt-4 border-t border-slate-800/90 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 font-display">
                  <Tag className="w-3.5 h-3.5 text-amber-400" />
                  <h2>Custom Tags</h2>
                </div>
                {selectedTag && (
                  <button
                    type="button"
                    onClick={() => handleSelectTag(selectedTag)}
                    className="text-[11px] text-amber-400 hover:underline cursor-pointer"
                  >
                    Clear Filter
                  </button>
                )}
              </div>

              {availableTags.length === 0 ? (
                <p className="text-[11px] text-slate-500 leading-snug">
                  No custom tags created yet. Click <span className="text-slate-400 font-mono">+ Tag</span> on any evidence card to tag items (e.g., #timeline, #witness, #key-document).
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {availableTags.map(({ tag, count }) => {
                    const isSelected = selectedTag === tag;
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleSelectTag(tag)}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono transition-colors cursor-pointer border ${
                          isSelected
                            ? 'bg-amber-500/25 border-amber-500 text-amber-200 font-semibold shadow-xs'
                            : 'bg-slate-900/90 hover:bg-slate-800 border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                        title={isSelected ? `Clear filter: ${tag}` : `Filter vault by ${tag} (${count} items)`}
                      >
                        <Hash className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                        <span>{tag.replace(/^#/, '')}</span>
                        <span className="text-[10px] text-slate-400 bg-slate-950/80 px-1 py-0.2 rounded-xs ml-0.5">
                          {count}
                        </span>
                        {isSelected && <X className="w-2.5 h-2.5 text-amber-300 ml-0.5" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Section 3: Target Google Drive Folder Scanning */}
            <div className="pt-4 border-t border-slate-800/90 space-y-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-slate-300 font-display">
                  Target Drive Folder
                </h2>
                {!needsAuth && user && (
                  <button
                    type="button"
                    onClick={handleGoogleLogout}
                    className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white cursor-pointer"
                    title="Sign out of Google Drive"
                  >
                    <LogOut className="w-3 h-3" />
                    <span>Sign out</span>
                  </button>
                )}
              </div>

              <div className="p-2.5 rounded-md border border-amber-500/30 bg-amber-950/15 space-y-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-mono text-amber-300 font-semibold truncate">
                    Folder ID: {TARGET_DRIVE_FOLDER_ID.slice(0, 10)}...
                  </span>
                  <a
                    href={TARGET_DRIVE_FOLDER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-amber-400 hover:underline shrink-0 font-medium"
                  >
                    Open in Drive ↗
                  </a>
                </div>
                <p className="text-[10px] text-slate-400 leading-tight">
                  Scans all transcripts, clip catalogs (# entries), JSONL and document files in this folder.
                </p>
              </div>

              {needsAuth ? (
                <button
                  type="button"
                  onClick={handleGoogleLogin}
                  disabled={isLoggingIn}
                  className="gsi-material-button w-full flex items-center justify-center gap-2.5 px-3 py-2 rounded-md bg-white text-slate-900 hover:bg-slate-100 text-xs font-medium transition-colors cursor-pointer"
                >
                  <div className="gsi-material-button-icon w-4 h-4 shrink-0">
                    <svg
                      version="1.1"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 48 48"
                      className="block w-full h-full"
                    >
                      <path
                        fill="#EA4335"
                        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                      />
                      <path
                        fill="#4285F4"
                        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                      />
                      <path
                        fill="#34A853"
                        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                      />
                      <path fill="none" d="M0 0h48v48H0z" />
                    </svg>
                  </div>
                  <span className="gsi-material-button-contents whitespace-nowrap">
                    {isLoggingIn ? 'Connecting...' : 'Sign in to Scan Folder'}
                  </span>
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="text-[11px] text-slate-400 truncate">
                    Connected as{' '}
                    <span className="text-slate-200 font-medium">
                      {user?.email || user?.displayName}
                    </span>
                  </div>

                  <button
                    type="button"
                    disabled={isScanningFolder}
                    onClick={() => handleScanTargetDriveFolder(nextJobStartIndex, true)}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 rounded-md transition-colors cursor-pointer shadow-xs"
                  >
                    {isScanningFolder ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Running Small Batch Jobs...</span>
                      </>
                    ) : (
                      <>
                        <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                        <span>Auto-Scan in Small Jobs (15 files/job)</span>
                      </>
                    )}
                  </button>

                  {!isScanningFolder && (
                    <div className="grid grid-cols-2 gap-1.5 pt-0.5">
                      <button
                        type="button"
                        onClick={() =>
                          handleScanTargetDriveFolder(nextJobStartIndex, false)
                        }
                        className="flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-medium text-slate-200 bg-[#141D2E] hover:bg-slate-800 border border-slate-800 hover:border-slate-700 rounded transition-colors cursor-pointer"
                        title="Process only one small batch of 15 files and pause"
                      >
                        <span>Run 1 Job (15 Files)</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleScanTargetDriveFolder(111, true)}
                        className="flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-medium text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded transition-colors cursor-pointer"
                        title="Start scanning specifically from file 112 through 142"
                      >
                        <span>From File 112</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Live Small-Batch Folder Scan Progress Card */}
              {isScanningFolder && folderScanProgress && (
                <div className="p-2.5 rounded border border-amber-500/40 bg-amber-950/30 space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-amber-300 font-semibold truncate">
                      {folderScanProgress.currentJobNumber
                        ? `Job ${folderScanProgress.currentJobNumber}/${folderScanProgress.totalJobs || 10}`
                        : 'Batch Job'}
                      {folderScanProgress.jobStartIndex && folderScanProgress.jobEndIndex
                        ? ` (Files ${folderScanProgress.jobStartIndex}–${folderScanProgress.jobEndIndex})`
                        : ''}
                    </span>
                    <span className="font-mono text-emerald-400 font-medium text-[10px] bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                      {folderScanProgress.totalChunksIngested} live in vault
                    </span>
                  </div>

                  <div className="text-[10px] text-slate-300 flex items-center justify-between">
                    <span className="truncate">
                      File {folderScanProgress.currentFileIndex}/{folderScanProgress.totalFiles}
                    </span>
                    <span className="font-mono text-slate-400">
                      {folderScanProgress.totalSourcesIngested} sources
                    </span>
                  </div>

                  <p className="text-[10px] text-slate-300 leading-tight truncate font-mono">
                    {folderScanProgress.message}
                  </p>

                  {folderScanProgress.totalFiles > 0 && (
                    <div className="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800">
                      <div
                        className="h-full bg-amber-500 transition-all duration-200"
                        style={{
                          width: `${Math.round(
                            (folderScanProgress.currentFileIndex /
                              folderScanProgress.totalFiles) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 pt-1 border-t border-amber-500/20">
                    <button
                      type="button"
                      onClick={() => {
                        if (folderScanProgress) {
                          skipCurrentScanningFile(
                            folderScanProgress.currentFileIndex - 1
                          );
                        }
                      }}
                      className="px-2 py-1 text-[10px] font-medium text-amber-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-amber-500/30 rounded cursor-pointer"
                      title="Skip this file if it is taking too long"
                    >
                      Skip File #{folderScanProgress.currentFileIndex}
                    </button>

                    <button
                      type="button"
                      onClick={handleStopScan}
                      className="px-2 py-1 text-[10px] font-medium text-slate-400 hover:text-red-300 bg-slate-900 hover:bg-red-950/40 border border-slate-800 rounded cursor-pointer"
                    >
                      Pause / Stop
                    </button>
                  </div>
                </div>
              )}

              {folderScanBanner && (
                <div
                  className={`p-2 rounded text-[11px] flex items-center justify-between gap-1.5 border ${
                    folderScanBanner.type === 'success'
                      ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                      : 'border-red-500/40 bg-red-950/30 text-red-300'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    {folderScanBanner.type === 'success' ? (
                      <Check className="w-3.5 h-3.5 shrink-0 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-red-400" />
                    )}
                    <span className="truncate">{folderScanBanner.message}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFolderScanBanner(null)}
                    className="text-slate-400 hover:text-white shrink-0 cursor-pointer p-0.5"
                    aria-label="Dismiss banner"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Section 4: Direct Import / Export Options & IndexedDB Storage Actions */}
          <div className="pt-5 border-t border-slate-800/90 space-y-2.5">
            <h2 className="text-xs font-semibold text-slate-300 font-display mb-2 flex items-center justify-between">
              <span>Streamed Dossiers & Media Packaging</span>
              <span className="text-[10px] text-amber-400 font-mono">Streamed</span>
            </h2>

            {/* Primary Action: Open Streamed Documentary Packaging Modal */}
            <button
              type="button"
              disabled={totalChunkCount === 0}
              onClick={() => setIsExportModalOpen(true)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-md transition-all shadow-xs cursor-pointer disabled:opacity-40"
            >
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <Layers className="w-3.5 h-3.5 shrink-0" />
                <span>Streamed Dossier Builder</span>
              </span>
              <Film className="w-3.5 h-3.5 shrink-0" />
            </button>

            <div className="grid grid-cols-2 gap-1.5 pt-1">
              {/* Quick Streamed Brief */}
              <button
                type="button"
                disabled={totalChunkCount === 0}
                onClick={() =>
                  streamExportStructuredBrief({
                    sourceId: selectedSourceId,
                    classification: selectedClassification,
                  })
                }
                className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-slate-200 bg-[#141D2E] hover:bg-slate-800 border border-slate-800 rounded transition-colors disabled:opacity-40 cursor-pointer"
                title="Stream formatted Markdown dossier grouped by entity"
              >
                <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Brief (.md)</span>
              </button>

              {/* Quick Streamed CMX 3600 EDL */}
              <button
                type="button"
                disabled={totalChunkCount === 0}
                onClick={() =>
                  streamExportNleCutList({
                    sourceId: selectedSourceId,
                    classification: selectedClassification,
                  })
                }
                className="flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] font-medium text-slate-200 bg-[#141D2E] hover:bg-slate-800 border border-slate-800 rounded transition-colors disabled:opacity-40 cursor-pointer"
                title="Stream CMX 3600 EDL for Premiere, Resolve, Final Cut"
              >
                <Film className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>NLE Cut List</span>
              </button>
            </div>

            <input
              ref={jsonlFileInputRef}
              type="file"
              accept=".jsonl,application/json,text/plain"
              onChange={handleJsonlFileInputChange}
              className="hidden"
            />

            <button
              type="button"
              onClick={() => jsonlFileInputRef.current?.click()}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-md transition-colors cursor-pointer"
            >
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <Upload className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Import Corpus (JSONL)</span>
              </span>
              <FileJson className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            </button>

            <button
              type="button"
              disabled={totalChunkCount === 0}
              onClick={() => streamExportJsonl()}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-200 bg-[#141D2E] hover:bg-slate-800 border border-slate-800 rounded-md transition-colors disabled:opacity-40 cursor-pointer"
            >
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <FileJson className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>Stream Corpus (JSONL)</span>
              </span>
              <Download className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            </button>

            <button
              type="button"
              disabled={totalChunkCount === 0}
              onClick={() => exportEvidenceMapAsMarkdown()}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-slate-200 bg-[#141D2E] hover:bg-slate-800 border border-slate-800 rounded-md transition-colors disabled:opacity-40 cursor-pointer"
            >
              <span className="inline-flex items-center gap-2 whitespace-nowrap">
                <FileText className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span>Export Evidence Map (MD)</span>
              </span>
              <Download className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            </button>

            {hasSampleData && (
              <button
                type="button"
                onClick={handleClearSampleData}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-400 hover:text-red-300 hover:bg-red-950/30 border border-slate-800/80 hover:border-red-500/30 rounded-md transition-colors cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span>Clear Sample Data</span>
              </button>
            )}

            {sources.length > 0 && (
              <button
                type="button"
                onClick={handleClearVault}
                className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                  confirmClearAll
                    ? 'bg-red-950/60 border-red-500/60 text-red-200'
                    : 'text-slate-400 hover:text-red-300 hover:bg-red-950/30 border-slate-800/80 hover:border-red-500/30'
                }`}
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {confirmClearAll
                    ? 'Click Again to Confirm Clear All'
                    : 'Clear All Vault Data'}
                </span>
              </button>
            )}
          </div>
        </aside>

        {/* CENTER CANVAS: Unified Search + Ask Vault Bar + Evidence Card Feed */}
        <main className="flex-1 min-w-0 p-6 lg:p-8">
          {/* Import Status / Line Validation Toast Banner */}
          {importBanner && (
            <div
              role="alert"
              className={`mb-5 px-4 py-3 rounded-lg border flex items-center justify-between gap-3 text-xs ${
                importBanner.type === 'error'
                  ? 'bg-red-950/50 border-red-500/60 text-red-200'
                  : 'bg-emerald-950/40 border-emerald-500/50 text-emerald-200'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {importBanner.type === 'error' ? (
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                ) : (
                  <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                )}
                <span className="font-medium break-words">
                  {importBanner.message}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setImportBanner(null)}
                className="text-slate-400 hover:text-white shrink-0 cursor-pointer"
                aria-label="Dismiss notification"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Unified Search & Ask Vault (Argon) Bar */}
          <div className="mb-6">
            <form
              onSubmit={handleAskVault}
              className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
            >
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    if (askVaultResult && !e.target.value.trim()) {
                      setAskVaultResult(null);
                    }
                  }}
                  placeholder="Instant filter by keyword, speaker, coordinate, named entity, or type a thematic question for Ask Vault (Argon)..."
                  className="w-full pl-10 pr-9 py-2.5 text-xs sm:text-sm bg-[#121926] border border-slate-800 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-amber-500/80 transition-colors"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setAskVaultResult(null);
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
                    aria-label="Clear search"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <button
                type="submit"
                disabled={
                  isAskingVault || !searchQuery.trim() || totalChunkCount === 0
                }
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 rounded-lg transition-colors disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
                title="Synthesize thematic answer with Gemini 4 Argon and filter matching evidence"
              >
                {isAskingVault ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
                    <span>Analyzing Vault...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Ask Vault (Argon)</span>
                  </>
                )}
              </button>
            </form>

            {/* Feed Context Line */}
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
              <div className="flex flex-wrap items-center gap-2">
                <span>Showing</span>
                <span className="font-mono tabular-nums text-white font-medium">
                  {totalFilteredCount}
                </span>
                <span>matching records</span>
                <span className="text-slate-500 font-mono text-[11px]">
                  ({totalChunkCount} total in vault)
                </span>
                {isWorkerSearching && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>FTS indexing...</span>
                  </span>
                )}
                {searchDurationMs !== null && debouncedSearchQuery.trim() && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-mono bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-500/30">
                    <Zap className="w-3 h-3" />
                    <span>Worker match in {searchDurationMs}ms</span>
                  </span>
                )}
                {activeSourceObj && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      Source:{' '}
                      <strong className="text-slate-200">
                        {activeSourceObj.title}
                      </strong>
                    </span>
                  </>
                )}
                {selectedTag && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      <Hash className="w-3 h-3 text-amber-400" />
                      <span>Tag: {selectedTag}</span>
                      <button
                        type="button"
                        onClick={() => handleSelectTag(selectedTag)}
                        className="text-amber-400/70 hover:text-white cursor-pointer ml-0.5 p-0.5"
                        title="Clear custom tag filter"
                        aria-label="Clear custom tag filter"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Ask Vault (Argon) Thematic Synthesis Banner */}
          {askVaultResult && (
            <AskVaultBanner
              result={askVaultResult}
              isFilteringByResult={filterByAskResult}
              onToggleFilterByResult={() =>
                setFilterByAskResult((prev) => !prev)
              }
              onClearResult={() => setAskVaultResult(null)}
              onSelectEntity={handleSelectEntity}
            />
          )}

          {/* Evidence Chunk Feed with Windowed Infinite Virtualization */}
          {isLoadingDB ? (
            <div className="space-y-4">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className="h-36 rounded-lg border border-slate-800/80 bg-[#121926]/60 animate-pulse p-5"
                />
              ))}
            </div>
          ) : totalFilteredCount === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-800 bg-[#0E131F]/60 p-12 text-center max-w-xl mx-auto my-8">
              <FolderOpen className="w-8 h-8 text-slate-500 mx-auto mb-3" />
              <h3 className="text-sm font-semibold text-white font-display mb-1">
                {totalChunkCount === 0
                  ? 'Evidence Vault is Empty'
                  : 'No Matching Evidence Chunks'}
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-5">
                {totalChunkCount === 0
                  ? 'Drag and drop a WebVTT (.vtt), SRT (.srt), Audio Clip Catalog (.txt), or Markdown document (.md) anywhere onto the workbench—or import directly from Google Drive.'
                  : 'No chunks matched your current filter or search criteria. Try clearing your search query or switching classification filters.'}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setDroppedFile(null);
                    setIsIngestionOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-500 hover:bg-amber-400 rounded-md transition-colors cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>Ingest Local or Google Drive File</span>
                </button>
                <button
                  type="button"
                  onClick={() => jsonlFileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-md transition-colors cursor-pointer"
                >
                  <FileJson className="w-3.5 h-3.5 text-amber-400" />
                  <span>Import Corpus (JSONL)</span>
                </button>
                {totalChunkCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSourceId('all');
                      setSelectedClassification('all');
                      setSelectedTag(null);
                      setSearchQuery('');
                      setDebouncedSearchQuery('');
                      setAskVaultResult(null);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-700 rounded-md transition-colors cursor-pointer"
                  >
                    <span>Reset All Filters</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <VirtualEvidenceList
              totalCount={totalFilteredCount}
              sourceId={selectedSourceId}
              classification={selectedClassification}
              tag={selectedTag}
              searchQuery={workerMatchIds ? '' : debouncedSearchQuery}
              matchedChunkIds={
                askVaultResult && filterByAskResult
                  ? askVaultResult.matched_chunk_ids
                  : workerMatchIds
              }
              onSelectEntity={handleSelectEntity}
              onSelectSource={handleSelectSource}
              onSelectTag={handleSelectTag}
              onTagsChanged={handleTagsChanged}
              highlightedChunkIds={askVaultResult?.matched_chunk_ids}
            />
          )}
        </main>
      </div>

      {/* Streamed Documentary Dossier Builder & Media Packaging Modal */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        sources={sources}
        totalChunkCount={totalChunkCount}
        selectedSourceId={selectedSourceId}
        selectedClassification={selectedClassification}
      />



      {/* Slide-Over Ingestion & Deterministic Preview Drawer */}
      <IngestionDrawer
        isOpen={isIngestionOpen}
        initialFile={droppedFile}
        onClose={() => {
          setIsIngestionOpen(false);
          setDroppedFile(null);
        }}
        onIngestComplete={handleIngestComplete}
        onJsonlImported={handleDrawerJsonlImported}
      />
    </div>
  );
}
