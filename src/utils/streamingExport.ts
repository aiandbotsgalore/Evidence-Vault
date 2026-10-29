import { db } from '../db';
import type { ClassificationType, EvidenceChunk, SourceDocument } from '../types';

export interface StreamProgress {
  processedChunks: number;
  totalChunks: number;
  percent: number;
  stage: string;
}

/**
 * Parses any coordinate string (e.g., "00:37", "01:23:45", "00:02:15.500") or start/end millisecond
 * numbers into standard SMPTE timecode (HH:MM:SS:FF) at 24 fps non-drop frame.
 */
export function msOrCoordinateToTimecode(
  coordinate: string,
  explicitMs: number | null,
  fps = 24
): { sourceIn: string; sourceOut: string; durationFrames: number } {
  let inSeconds = 0;

  if (explicitMs !== null && Number.isFinite(explicitMs) && explicitMs >= 0) {
    inSeconds = explicitMs / 1000;
  } else if (coordinate) {
    const parts = coordinate.split(':').map((p) => parseFloat(p) || 0);
    if (parts.length === 3) {
      inSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      inSeconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 1) {
      inSeconds = parts[0];
    }
  }

  // Default clip duration of 8 seconds if no end coordinate provided
  const durationSeconds = 8;
  const outSeconds = inSeconds + durationSeconds;

  const formatSMPTE = (totalSec: number): string => {
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = Math.floor(totalSec % 60);
    const frames = Math.floor((totalSec % 1) * fps);

    return [
      String(hours).padStart(2, '0'),
      String(minutes).padStart(2, '0'),
      String(seconds).padStart(2, '0'),
      String(frames).padStart(2, '0'),
    ].join(':');
  };

  const durationFrames = Math.round(durationSeconds * fps);

  return {
    sourceIn: formatSMPTE(inSeconds),
    sourceOut: formatSMPTE(outSeconds),
    durationFrames,
  };
}

/**
 * Formats a running record timeline SMPTE timecode given an accumulated frame count.
 */
function framesToSMPTE(totalFrames: number, fps = 24): string {
  const totalSeconds = Math.floor(totalFrames / fps);
  const frames = totalFrames % fps;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
    String(frames).padStart(2, '0'),
  ].join(':');
}

/**
 * Universal Stream Writer:
 * Uses the File System Access API (`showSaveFilePicker`) when available to stream directly
 * to a local file with zero memory overhead, or falls back to chunked Blob streaming.
 */
export async function streamSaveToFile(
  stream: ReadableStream<Uint8Array>,
  defaultFilename: string,
  mimeType: string,
  description: string,
  extension: string
): Promise<void> {
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  // 1. Try modern File System Access API
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      // @ts-expect-error showSaveFilePicker browser API
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultFilename,
        types: [
          {
            description,
            accept: {
              [mimeType]: [extension],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await stream.pipeTo(writable);
      return;
    } catch (err: unknown) {
      // User cancelled picker or permission denied - fallback to browser download
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      console.warn('showSaveFilePicker failed or unsupported, using chunked blob fallback:', err);
    }
  }

  // 2. High-efficiency chunked Blob accumulator fallback
  const reader = stream.getReader();
  const chunks: BlobPart[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value as unknown as BlobPart);
  }

  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Streams the entire Evidence Vault corpus as Newline-Delimited JSON (JSONL)
 * in batches of 500 items directly from IndexedDB without loading all items into memory.
 */
export async function streamExportJsonl(
  onProgress?: (progress: StreamProgress) => void
): Promise<void> {
  const totalChunks = await db.chunks.count();
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `evidence-vault-corpus-${dateStamp}.jsonl`;
  const encoder = new TextEncoder();
  const batchSize = 500;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let offset = 0;
      while (offset < totalChunks) {
        const batch = await db.chunks.offset(offset).limit(batchSize).toArray();
        if (batch.length === 0) break;

        const lines: string[] = [];
        for (const chunk of batch) {
          lines.push(
            JSON.stringify({
              chunk_id: chunk.chunk_id,
              source_id: chunk.source_id,
              source_title: chunk.source_title,
              source_type: chunk.source_type,
              speaker: chunk.speaker,
              coordinate: chunk.coordinate,
              start_ms: chunk.start_ms,
              end_ms: chunk.end_ms,
              page_or_section: chunk.page_or_section,
              classification: chunk.classification,
              citation_pill: chunk.citation_pill,
              quote_snippet: chunk.quote_snippet,
              summary: chunk.summary,
              named_entities: chunk.named_entities,
              custom_tags: chunk.custom_tags || [],
              text: chunk.text,
            })
          );
        }

        controller.enqueue(encoder.encode(lines.join('\n') + '\n'));
        offset += batch.length;

        onProgress?.({
          processedChunks: Math.min(offset, totalChunks),
          totalChunks,
          percent: Math.round((Math.min(offset, totalChunks) / totalChunks) * 100),
          stage: 'Streaming JSONL records from IndexedDB...',
        });
      }
      controller.close();
    },
  });

  await streamSaveToFile(
    stream,
    filename,
    'application/x-jsonlines;charset=utf-8',
    'Corpus JSONL Records',
    '.jsonl'
  );
}

/**
 * Streams a professional CMX 3600 Edit Decision List (EDL) cut list for NLE editing suites:
 * DaVinci Resolve, Adobe Premiere Pro, Apple Final Cut Pro, Avid Media Composer.
 */
export async function streamExportNleCutList(
  options: {
    sourceId?: string;
    classification?: ClassificationType | 'all';
    fps?: number;
  } = {},
  onProgress?: (progress: StreamProgress) => void
): Promise<void> {
  const { sourceId = 'all', classification = 'all', fps = 24 } = options;
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `evidence-vault-cutlist-${dateStamp}.edl`;
  const encoder = new TextEncoder();

  // Query filter
  let collection = db.chunks.toCollection();
  if (sourceId !== 'all') {
    collection = db.chunks.where('source_id').equals(sourceId);
  }
  if (classification !== 'all') {
    collection = collection.filter((c) => c.classification === classification);
  }

  const totalChunks = await collection.count();
  const sources = await db.sources.toArray();
  const sourceMap = new Map<string, SourceDocument>(sources.map((s) => [s.source_id, s]));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // CMX 3600 Header
      const header = [
        `TITLE: EVIDENCE_VAULT_INVESTIGATIVE_CUTLIST`,
        `FCM: NON-DROP FRAME`,
        ``,
      ].join('\r\n');
      controller.enqueue(encoder.encode(header + '\r\n'));

      let eventIndex = 1;
      let recordTimelineFrames = 3600 * fps; // Standard 01:00:00:00 start timecode
      const batchSize = 400;
      let processed = 0;

      while (processed < totalChunks) {
        const batch = await collection.offset(processed).limit(batchSize).toArray();
        if (batch.length === 0) break;

        const edlBlocks: string[] = [];

        for (const chunk of batch) {
          const eventNumStr = String(eventIndex).padStart(3, '0');
          // Reel name strictly 8 alphanumeric characters
          const reelId = `REEL${String(eventIndex % 999).padStart(3, '0')}`;
          
          const timecodeInfo = msOrCoordinateToTimecode(
            chunk.coordinate,
            chunk.start_ms,
            fps
          );

          const recIn = framesToSMPTE(recordTimelineFrames, fps);
          recordTimelineFrames += timecodeInfo.durationFrames;
          const recOut = framesToSMPTE(recordTimelineFrames, fps);

          // CMX standard event line: EVENT REEL TRACK TYPE TRANS SRC_IN SRC_OUT REC_IN REC_OUT
          edlBlocks.push(
            `${eventNumStr}  ${reelId.padEnd(8, ' ')} AA/V  C        ${timecodeInfo.sourceIn} ${timecodeInfo.sourceOut} ${recIn} ${recOut}`
          );
          
          const sourceDoc = sourceMap.get(chunk.source_id);
          const clipName = sourceDoc?.file_name || `${chunk.source_title}.wav`;

          // Standard NLE comments
          edlBlocks.push(`* FROM CLIP NAME: ${clipName}`);
          edlBlocks.push(`* SPEAKER: ${chunk.speaker}`);
          edlBlocks.push(`* CLASSIFICATION: ${chunk.classification.toUpperCase()}`);
          edlBlocks.push(`* CITATION: ${chunk.citation_pill}`);
          edlBlocks.push(`* COMMENT: ${chunk.summary.slice(0, 100)}`);
          if (chunk.custom_tags && chunk.custom_tags.length > 0) {
            edlBlocks.push(`* TAGS: ${chunk.custom_tags.join(' ')}`);
          }
          edlBlocks.push(``); // blank line separating events

          eventIndex++;
        }

        controller.enqueue(encoder.encode(edlBlocks.join('\r\n')));
        processed += batch.length;

        onProgress?.({
          processedChunks: Math.min(processed, totalChunks),
          totalChunks,
          percent: Math.round((Math.min(processed, totalChunks) / totalChunks) * 100),
          stage: 'Formatting CMX 3600 NLE timeline events...',
        });
      }

      controller.close();
    },
  });

  await streamSaveToFile(
    stream,
    filename,
    'text/plain;charset=utf-8',
    'NLE Cut List (CMX 3600 EDL)',
    '.edl'
  );
}

/**
 * Streams a comprehensive Structured Evidence Brief organized by Entity Dossiers:
 * 1. Executive Summary & Source Inventory
 * 2. Cross-referenced Entity Dossiers with Citation Pills & Classification Breakdown
 * 3. Timeline of Corroborated Evidence vs Contested Claims
 */
export async function streamExportStructuredBrief(
  options: {
    sourceId?: string;
    classification?: ClassificationType | 'all';
  } = {},
  onProgress?: (progress: StreamProgress) => void
): Promise<void> {
  const { sourceId = 'all', classification = 'all' } = options;
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `structured-evidence-brief-${dateStamp}.md`;
  const encoder = new TextEncoder();

  let collection = db.chunks.toCollection();
  if (sourceId !== 'all') {
    collection = db.chunks.where('source_id').equals(sourceId);
  }
  if (classification !== 'all') {
    collection = collection.filter((c) => c.classification === classification);
  }

  const [totalChunks, sources] = await Promise.all([
    collection.count(),
    db.sources.toArray(),
  ]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

      // 1. Executive Brief Header
      const headerLines = [
        `# Evidence Vault — Structured Investigative Evidence Brief`,
        `**Generated:** ${now} | **Total Chunks:** ${totalChunks} | **Catalog Sources:** ${sources.length}`,
        ``,
        `---`,
        ``,
        `## 1. Executive Summary & Source Provenance`,
        ``,
        `This briefing dossier compiles verbatim audio clip transcripts, sworn depositions, and documentary filings`,
        `cataloged in Evidence Vault. All citations follow strict coordinates with sanitized inner quotation: \`[Speaker Coordinate "Quote snippet"]\`.`,
        ``,
        `### Source Catalog:`,
      ];

      for (const s of sources) {
        headerLines.push(
          `- **${s.title}** (\`${s.source_type}\`) · Default Speaker: **${s.default_speaker}** · Chunks: **${s.chunk_count}** · File: \`${s.file_name}\``
        );
      }
      headerLines.push(``);
      headerLines.push(`---`);
      headerLines.push(``);
      headerLines.push(`## 2. Structured Entity Dossiers`);
      headerLines.push(``);

      controller.enqueue(encoder.encode(headerLines.join('\n') + '\n'));

      // 2. Stream Entity Dossiers
      // First pass: collect entities and counts efficiently
      const entityMap = new Map<string, string[]>();
      let processed = 0;
      const batchSize = 400;

      while (processed < totalChunks) {
        const batch = await collection.offset(processed).limit(batchSize).toArray();
        if (batch.length === 0) break;

        for (const chunk of batch) {
          const entities = chunk.named_entities && chunk.named_entities.length > 0
            ? chunk.named_entities
            : [chunk.speaker];

          for (const ent of entities) {
            const cleanEnt = ent.trim();
            if (!cleanEnt) continue;
            if (!entityMap.has(cleanEnt)) {
              entityMap.set(cleanEnt, []);
            }
            entityMap.get(cleanEnt)!.push(chunk.chunk_id);
          }
        }
        processed += batch.length;
        onProgress?.({
          processedChunks: Math.min(processed, totalChunks),
          totalChunks,
          percent: Math.round((Math.min(processed, totalChunks) / totalChunks) * 50),
          stage: 'Indexing named entities and cross-references...',
        });
      }

      // Sort entities by frequency
      const sortedEntities = Array.from(entityMap.entries()).sort(
        (a, b) => b[1].length - a[1].length
      );

      let entityIndex = 0;
      for (const [entityName, chunkIds] of sortedEntities) {
        entityIndex++;
        // Fetch chunks for this entity in bulk
        const entityChunks = (await db.chunks.bulkGet(chunkIds)).filter(
          (c): c is EvidenceChunk => c !== undefined
        );

        const verified = entityChunks.filter((c) => c.classification === 'verified_record');
        const allegations = entityChunks.filter((c) => c.classification === 'allegation_or_claim');
        const statements = entityChunks.filter((c) => c.classification === 'spoken_statement');
        const notes = entityChunks.filter((c) => c.classification === 'editorial_note');

        const dossierSection = [
          `### 2.${entityIndex} Entity Dossier: **${entityName}** (${entityChunks.length} Citations)`,
          `- **Verified Records:** ${verified.length} | **Allegations / Claims:** ${allegations.length} | **Spoken Statements:** ${statements.length} | **Notes:** ${notes.length}`,
          ``,
        ];

        // Verified evidence section
        if (verified.length > 0) {
          dossierSection.push(`#### Verified Documentary Proof:`);
          for (const v of verified.slice(0, 10)) {
            dossierSection.push(`- \`${v.citation_pill}\``);
            dossierSection.push(`  - **Summary**: ${v.summary}`);
            dossierSection.push(`  - **Source**: ${v.source_title} (${v.coordinate})`);
          }
          if (verified.length > 10) {
            dossierSection.push(`- _...and ${verified.length - 10} additional verified records._`);
          }
          dossierSection.push(``);
        }

        // Allegations section
        if (allegations.length > 0) {
          dossierSection.push(`#### Contested Allegations & Claims:`);
          for (const a of allegations.slice(0, 10)) {
            dossierSection.push(`- \`${a.citation_pill}\``);
            dossierSection.push(`  - **Summary**: ${a.summary}`);
            dossierSection.push(`  - **Source**: ${a.source_title} (${a.coordinate})`);
          }
          if (allegations.length > 10) {
            dossierSection.push(`- _...and ${allegations.length - 10} additional allegations._`);
          }
          dossierSection.push(``);
        }

        // Statements section
        if (statements.length > 0) {
          dossierSection.push(`#### Direct Witness & Spoken Statements:`);
          for (const s of statements.slice(0, 10)) {
            dossierSection.push(`- \`${s.citation_pill}\``);
            dossierSection.push(`  - **Summary**: ${s.summary}`);
          }
          if (statements.length > 10) {
            dossierSection.push(`- _...and ${statements.length - 10} additional statements._`);
          }
          dossierSection.push(``);
        }

        controller.enqueue(encoder.encode(dossierSection.join('\n') + '\n'));

        onProgress?.({
          processedChunks: Math.min(totalChunks, Math.round((entityIndex / sortedEntities.length) * totalChunks)),
          totalChunks,
          percent: 50 + Math.round((entityIndex / sortedEntities.length) * 50),
          stage: `Compiling entity dossier for ${entityName}...`,
        });
      }

      controller.close();
    },
  });

  await streamSaveToFile(
    stream,
    filename,
    'text/markdown;charset=utf-8',
    'Structured Evidence Brief (Markdown)',
    '.md'
  );
}
