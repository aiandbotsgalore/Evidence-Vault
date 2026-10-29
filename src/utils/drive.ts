import { getAccessToken } from '../auth';
import { db } from '../db';
import {
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
} from './parser';
import {
  detectIsJsonlCorpus,
  importCorpusFromJsonl,
} from './exporters';

export const TARGET_DRIVE_FOLDER_ID = '1bfKW0y2QO-JV6eLf88fgOKu24Il6jyon';
export const TARGET_DRIVE_FOLDER_URL =
  'https://drive.google.com/drive/folders/1bfKW0y2QO-JV6eLf88fgOKu24Il6jyon?usp=sharing';

export const DEFAULT_BATCH_JOB_SIZE = 15;

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
}

export interface ScanFolderProgress {
  status:
    | 'connecting'
    | 'listing'
    | 'processing'
    | 'job_completed'
    | 'completed'
    | 'error'
    | 'stopped';
  currentFileIndex: number;
  totalFiles: number;
  currentFileName?: string;
  totalChunksIngested: number;
  totalSourcesIngested: number;
  currentJobNumber?: number;
  totalJobs?: number;
  jobStartIndex?: number;
  jobEndIndex?: number;
  message: string;
}

export interface ScanFolderResult {
  totalFiles: number;
  ingestedSourcesCount: number;
  ingestedChunksCount: number;
  sources: { title: string; chunkCount: number; fileName: string }[];
  skippedFiles: string[];
  nextStartIndex?: number | null;
  completedJobNumber?: number;
  totalJobs?: number;
}

export interface ScanFolderOptions {
  startIndex?: number; // 0-based index to start or resume from
  maxFilesPerJob?: number; // small job size (e.g. 15 files)
  runAllJobsSequentially?: boolean; // if false, processes 1 small job of 15 files and stops; if true, runs sequentially with brief job pauses
  skipAlreadyIngested?: boolean;
  onProgress?: (progress: ScanFolderProgress) => void;
  onFileIngested?: (
    source: SourceDocument,
    chunks: EvidenceChunk[]
  ) => Promise<void> | void;
  signal?: AbortSignal;
}

// Global hook to immediately skip the currently hanging file from UI
let manualSkipFileIndex: number | null = null;
export function skipCurrentScanningFile(fileIndex: number): void {
  manualSkipFileIndex = fileIndex;
}

/**
 * Lists all files inside the target Google Drive folder (folder ID: 1bfKW0y2QO-JV6eLf88fgOKu24Il6jyon).
 */
export async function listTargetFolderFiles(): Promise<DriveFileItem[]> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error('Google Drive authorization required.');
  }

  const allFiles: DriveFileItem[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const params = new URLSearchParams({
      q: `'${TARGET_DRIVE_FOLDER_ID}' in parents and trashed = false`,
      pageSize: '100',
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      orderBy: 'name asc',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        errData?.error?.message ||
          `Failed to access Google Drive folder (${res.status}). Verify folder permissions.`
      );
    }

    const data = await res.json();
    if (Array.isArray(data.files)) {
      allFiles.push(...data.files);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

/**
 * Downloads the text content of a Google Drive file or exports a Google Doc as text/plain.
 * Enforces a strict 10-second timeout so a slow or hanging file never stalls the scanner.
 */
export async function downloadDriveFileContent(
  file: DriveFileItem,
  signal?: AbortSignal,
  timeoutMs = 10000
): Promise<{ name: string; content: string }> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error('Google Drive authorization required.');
  }

  const isGoogleDoc =
    file.mimeType === 'application/vnd.google-apps.document';

  const endpoint = isGoogleDoc
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        file.id
      )}/export?mimeType=text/plain`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        file.id
      )}?alt=media`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const abortHandler = () => controller.abort();
  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    const res = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(
        errData?.error?.message ||
          `Download error for "${file.name}" (${res.status})`
      );
    }

    const content = await res.text();
    const normalizedName =
      isGoogleDoc && !/\.(txt|md|vtt|srt)$/i.test(file.name)
        ? `${file.name}.txt`
        : file.name;

    return {
      name: normalizedName,
      content,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
    if (controller.signal.aborted) {
      throw new Error(`Download timed out after ${timeoutMs / 1000}s on "${file.name}"`);
    }
    throw err;
  }
}

/**
 * Strict binary media & non-text file filter.
 * Skips images, audio/video binaries, PDFs, spreadsheets, presentations, zip/archives, and files > 8MB.
 */
function isBinaryMedia(file: DriveFileItem): boolean {
  const m = (file.mimeType || '').toLowerCase();
  const n = (file.name || '').toLowerCase();

  // Skip files larger than 8MB (evidence transcripts/catalogs are < 5MB)
  if (file.size && parseInt(file.size, 10) > 8 * 1024 * 1024) {
    return true;
  }

  if (
    m.startsWith('audio/') ||
    m.startsWith('video/') ||
    m.startsWith('image/') ||
    m.includes('pdf') ||
    m.includes('spreadsheet') ||
    m.includes('presentation') ||
    m.includes('drawing') ||
    m.includes('form') ||
    m.includes('folder') ||
    m.includes('shortcut') ||
    m.includes('zip') ||
    m.includes('tar') ||
    m.includes('gzip') ||
    m === 'application/octet-stream'
  ) {
    return true;
  }

  return /\.(mp3|wav|m4a|aac|ogg|flac|opus|wma|aiff|m4b|mp4|mov|mkv|avi|webm|m4v|png|jpg|jpeg|gif|webp|svg|bmp|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|tar|gz|rar|7z|bin|exe|dmg|iso|apk|DS_Store)$/i.test(
    n
  );
}

/**
 * Derives source metadata and default speaker deterministically from file content and name.
 */
function deriveSourceMetadata(
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

  const title = baseName
    ? baseName.replace(/\b\w/g, (l) => l.toUpperCase())
    : 'Evidence File';

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
      lower.includes('petition'))
  ) {
    sourceType = 'court_filing';
  }

  let defaultSpeaker = 'Speaker';

  if (isClipCatalog) {
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
      defaultSpeaker = title.split(' ').slice(0, 2).join(' ') || 'Speaker';
    }
  } else if (sourceType === 'court_filing') {
    defaultSpeaker = title.startsWith('Doc:') ? title : `Doc: ${title.slice(0, 24)}`;
  } else if (sourceType === 'editorial_note') {
    defaultSpeaker = 'Note: Producer';
  } else {
    const vttMatch = content.match(/<v\s+([^>]+)>/i);
    const bracketMatch = content.match(/\[([A-Za-z0-9\s.'-]{2,30})\]:/);
    const colonMatch = content.match(/^([A-Z][A-Za-z\s.'-]{2,28}):\s+/m);
    if (vttMatch) defaultSpeaker = vttMatch[1].trim();
    else if (bracketMatch) defaultSpeaker = bracketMatch[1].trim();
    else if (colonMatch) defaultSpeaker = colonMatch[1].trim();
    else defaultSpeaker = title.slice(0, 28);
  }

  return { title, sourceType, defaultSpeaker };
}

/**
 * Scans files in target folder `1bfKW0y2QO-JV6eLf88fgOKu24Il6jyon` broken down into
 * small, manageable jobs (default 15 files per job).
 *
 * Key guarantees:
 * 1. Immediate insertion into IndexedDB per-file as soon as it's parsed.
 * 2. `onFileIngested` callback after each file so the UI updates live in real-time.
 * 3. Does not run as a single giant crash-prone job; processes in discrete checkpoints.
 * 4. 10-second per-file timeout prevents any file from hanging.
 * 5. Smart resume fast-forwards existing files.
 */
export async function scanAndIngestDriveFolder(
  optionsOrProgress?:
    | ((progress: ScanFolderProgress) => void)
    | ScanFolderOptions
): Promise<ScanFolderResult> {
  const options: ScanFolderOptions =
    typeof optionsOrProgress === 'function'
      ? { onProgress: optionsOrProgress }
      : optionsOrProgress || {};

  const onProgress = options.onProgress;
  const onFileIngested = options.onFileIngested;
  const skipAlreadyIngested = options.skipAlreadyIngested ?? true;
  const batchJobSize = options.maxFilesPerJob ?? DEFAULT_BATCH_JOB_SIZE;
  const runAllSequentially = options.runAllJobsSequentially ?? true;
  manualSkipFileIndex = null;

  onProgress?.({
    status: 'connecting',
    currentFileIndex: 0,
    totalFiles: 0,
    totalChunksIngested: 0,
    totalSourcesIngested: 0,
    message: 'Connecting to Google Drive folder and retrieving file list...',
  });

  const files = await listTargetFolderFiles();
  const totalFiles = files.length;

  if (totalFiles === 0) {
    onProgress?.({
      status: 'completed',
      currentFileIndex: 0,
      totalFiles: 0,
      totalChunksIngested: 0,
      totalSourcesIngested: 0,
      message: 'Folder scanned: No files found in target folder.',
    });
    return {
      totalFiles: 0,
      ingestedSourcesCount: 0,
      ingestedChunksCount: 0,
      sources: [],
      skippedFiles: [],
      nextStartIndex: null,
    };
  }

  // Pre-load existing sources from Dexie so we can instantly skip already-ingested files
  const existingSources = await db.sources.toArray();
  const existingSourceFileNames = new Set(
    existingSources.map((s) => (s.file_name || '').toLowerCase().trim())
  );
  const existingSourceTitles = new Set(
    existingSources.map((s) => (s.title || '').toLowerCase().trim())
  );

  const totalJobs = Math.ceil(totalFiles / batchJobSize);
  let globalStartIndex = options.startIndex !== undefined ? options.startIndex : 0;
  if (globalStartIndex >= totalFiles) {
    globalStartIndex = 0;
  }

  const startJobNumber = Math.floor(globalStartIndex / batchJobSize) + 1;

  const result: ScanFolderResult = {
    totalFiles,
    ingestedSourcesCount: 0,
    ingestedChunksCount: 0,
    sources: [],
    skippedFiles: [],
    totalJobs,
  };

  let currentFilePtr = globalStartIndex;

  // Process files job-by-job
  for (
    let jobIdx = Math.floor(globalStartIndex / batchJobSize);
    jobIdx < totalJobs;
    jobIdx++
  ) {
    const jobNum = jobIdx + 1;
    const jobStart = jobIdx * batchJobSize;
    const jobEnd = Math.min(jobStart + batchJobSize, totalFiles);

    // If starting mid-job from globalStartIndex
    const effectiveStart = Math.max(jobStart, globalStartIndex);

    onProgress?.({
      status: 'processing',
      currentFileIndex: effectiveStart + 1,
      totalFiles,
      currentJobNumber: jobNum,
      totalJobs,
      jobStartIndex: jobStart + 1,
      jobEndIndex: jobEnd,
      totalChunksIngested: result.ingestedChunksCount,
      totalSourcesIngested: result.ingestedSourcesCount,
      message: `Starting Small Job ${jobNum} of ${totalJobs} (Files ${jobStart + 1}–${jobEnd})...`,
    });

    for (let i = effectiveStart; i < jobEnd; i++) {
      currentFilePtr = i;

      // Check if scan was aborted by caller
      if (options.signal?.aborted) {
        onProgress?.({
          status: 'stopped',
          currentFileIndex: i,
          totalFiles,
          currentJobNumber: jobNum,
          totalJobs,
          totalChunksIngested: result.ingestedChunksCount,
          totalSourcesIngested: result.ingestedSourcesCount,
          message: `Scan stopped at file ${i} of ${totalFiles}. All parsed files remain saved in vault.`,
        });
        result.nextStartIndex = i;
        result.completedJobNumber = jobNum;
        return result;
      }

      const file = files[i];
      const normalizedLowerName = file.name.toLowerCase().trim();

      // Check if manually skipped from UI
      if (manualSkipFileIndex === i) {
        result.skippedFiles.push(`${file.name} (Skipped by user)`);
        continue;
      }

      // Skip binary media, images, video, audio, PDFs, spreadsheets, and large archives
      if (isBinaryMedia(file)) {
        result.skippedFiles.push(`${file.name} (Non-text media / binary)`);
        continue;
      }

      // Smart resume: If file is already ingested in Dexie, fast-forward
      if (skipAlreadyIngested && existingSourceFileNames.has(normalizedLowerName)) {
        onProgress?.({
          status: 'processing',
          currentFileIndex: i + 1,
          totalFiles,
          currentFileName: file.name,
          currentJobNumber: jobNum,
          totalJobs,
          jobStartIndex: jobStart + 1,
          jobEndIndex: jobEnd,
          totalChunksIngested: result.ingestedChunksCount,
          totalSourcesIngested: result.ingestedSourcesCount,
          message: `File ${i + 1}/${totalFiles} (${file.name}): already saved in vault.`,
        });
        continue;
      }

      onProgress?.({
        status: 'processing',
        currentFileIndex: i + 1,
        totalFiles,
        currentFileName: file.name,
        currentJobNumber: jobNum,
        totalJobs,
        jobStartIndex: jobStart + 1,
        jobEndIndex: jobEnd,
        totalChunksIngested: result.ingestedChunksCount,
        totalSourcesIngested: result.ingestedSourcesCount,
        message: `Job ${jobNum}/${totalJobs} · Parsing file ${i + 1}/${totalFiles}: "${file.name}"...`,
      });

      try {
        // Small 30ms polite throttle
        await new Promise((r) => setTimeout(r, 30));

        // Download with strict 10s timeout
        const { name, content } = await downloadDriveFileContent(
          file,
          options.signal,
          10000
        );

        if (!content || !content.trim()) {
          result.skippedFiles.push(`${file.name} (Empty content)`);
          continue;
        }

        // 1. JSONL Corpus file
        if (detectIsJsonlCorpus(name, content)) {
          const importRes = await importCorpusFromJsonl(content, name);
          result.ingestedSourcesCount += importRes.importedSourcesCount;
          result.ingestedChunksCount += importRes.importedChunksCount;
          result.sources.push({
            title: name.replace(/\.jsonl$/i, ''),
            chunkCount: importRes.importedChunksCount,
            fileName: name,
          });
          existingSourceFileNames.add(normalizedLowerName);

          // Live update Dexie & trigger immediate UI refresh!
          if (onFileIngested) {
            const firstSource = await db.sources.get(
              importRes.firstSourceId || ''
            );
            if (firstSource) {
              const fileChunks = await db.chunks
                .where('source_id')
                .equals(firstSource.source_id)
                .toArray();
              await onFileIngested(firstSource, fileChunks);
            }
          }
          continue;
        }

        // 2. Deterministic parse for text/transcript/audio clip catalog
        const { title, sourceType, defaultSpeaker } = deriveSourceMetadata(
          name,
          content
        );

        // Avoid duplicate source title if already in database
        if (skipAlreadyIngested && existingSourceTitles.has(title.toLowerCase())) {
          continue;
        }

        const sourceId = `src_${Date.now().toString(36)}_${i}_${title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .slice(0, 16)}`;

        let rawChunks: RawDeterministicChunk[] = [];
        const isClipCatalog = detectIsAudioClipCatalog(content);
        const isTranscript = detectIsTranscript(name, content, sourceType);

        if (isClipCatalog) {
          rawChunks = parseAudioClipCatalogDeterministically(
            content,
            sourceId,
            title,
            sourceType,
            defaultSpeaker
          );
        } else if (isTranscript) {
          rawChunks = parseTranscriptDeterministically(
            content,
            sourceId,
            title,
            sourceType,
            defaultSpeaker
          );
        } else {
          rawChunks = parseDocumentDeterministically(
            content,
            sourceId,
            title,
            sourceType,
            defaultSpeaker
          );
        }

        if (rawChunks.length === 0) {
          result.skippedFiles.push(`${name} (No parseable evidence chunks)`);
          continue;
        }

        const chunksToInsert: EvidenceChunk[] = rawChunks.map((rc) => {
          const fallback = deterministicFallbackClassify(rc);
          const preferredSnippet = isClipCatalog ? rc.text : undefined;
          const { quote_snippet, citation_pill } = buildCitationPill(
            rc.speaker,
            rc.coordinate,
            rc.text,
            preferredSnippet
          );

          return {
            chunk_id: rc.chunk_id,
            source_id: rc.source_id,
            source_title: rc.source_title,
            source_type: rc.source_type,
            speaker: rc.speaker,
            coordinate: rc.coordinate,
            start_ms: rc.start_ms,
            end_ms: rc.end_ms,
            page_or_section: rc.page_or_section,
            text: rc.text,
            quote_snippet,
            citation_pill,
            classification: fallback.classification,
            summary: fallback.summary,
            named_entities: fallback.named_entities,
            is_sample: false,
          };
        });

        const sourceDoc: SourceDocument = {
          source_id: sourceId,
          title,
          source_type: sourceType,
          default_speaker: defaultSpeaker,
          file_name: name,
          ingested_at: new Date().toISOString(),
          chunk_count: chunksToInsert.length,
          is_sample: false,
        };

        // Commit immediately to Dexie so file is persisted right now!
        await db.transaction('rw', db.sources, db.chunks, async () => {
          await db.sources.put(sourceDoc);
          await db.chunks.bulkPut(chunksToInsert);
        });

        result.ingestedSourcesCount += 1;
        result.ingestedChunksCount += chunksToInsert.length;
        result.sources.push({
          title,
          chunkCount: chunksToInsert.length,
          fileName: name,
        });

        existingSourceFileNames.add(normalizedLowerName);
        existingSourceTitles.add(title.toLowerCase());

        // Notify caller for immediate real-time insertion into the UI!
        if (onFileIngested) {
          try {
            await onFileIngested(sourceDoc, chunksToInsert);
          } catch (uiErr) {
            console.warn('UI live refresh notification error:', uiErr);
          }
        }
      } catch (err: unknown) {
        console.warn(`File ${i + 1}/${totalFiles} (${file.name}) skipped:`, err);
        result.skippedFiles.push(
          `${file.name} (${err instanceof Error ? err.message : 'Timeout or read error'})`
        );
      }
    }

    // Small Job completed checkpoint
    result.completedJobNumber = jobNum;
    const nextStart = jobEnd < totalFiles ? jobEnd : null;
    result.nextStartIndex = nextStart;

    onProgress?.({
      status: 'job_completed',
      currentFileIndex: jobEnd,
      totalFiles,
      currentJobNumber: jobNum,
      totalJobs,
      jobStartIndex: jobStart + 1,
      jobEndIndex: jobEnd,
      totalChunksIngested: result.ingestedChunksCount,
      totalSourcesIngested: result.ingestedSourcesCount,
      message: `Completed Small Job ${jobNum} of ${totalJobs} (${jobEnd}/${totalFiles} files). Stored in IndexedDB.`,
    });

    // If single job mode was requested, stop here
    if (!runAllSequentially) {
      return result;
    }

    // If running all sequentially, take a gentle 250ms breath between jobs
    if (jobIdx < totalJobs - 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  onProgress?.({
    status: 'completed',
    currentFileIndex: totalFiles,
    totalFiles,
    totalChunksIngested: result.ingestedChunksCount,
    totalSourcesIngested: result.ingestedSourcesCount,
    message: `All small jobs completed: Processed all ${totalFiles} files. Ingested ${result.ingestedChunksCount} chunks across ${result.ingestedSourcesCount} source file${
      result.ingestedSourcesCount === 1 ? '' : 's'
    }.`,
  });

  result.nextStartIndex = null;
  return result;
}
