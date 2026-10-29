import { db } from '../db';
import {
  ClassificationType,
  EvidenceChunk,
  SourceDocument,
  SourceType,
} from '../types';
import { buildCitationPill } from './parser';

const VALID_CLASSIFICATIONS = new Set<ClassificationType>([
  'verified_record',
  'spoken_statement',
  'allegation_or_claim',
  'editorial_note',
]);

const VALID_SOURCE_TYPES = new Set<SourceType>([
  'archival_audio',
  'court_filing',
  'witness_interview',
  'editorial_note',
]);

export interface JsonlImportResult {
  importedChunksCount: number;
  importedSourcesCount: number;
  firstSourceId: string | null;
  warnings: string[];
}

/**
 * Detects whether a file or content string is a JSONL corpus file.
 */
export function detectIsJsonlCorpus(
  fileName: string,
  content: string
): boolean {
  if (fileName.toLowerCase().endsWith('.jsonl')) {
    return true;
  }
  const firstNonEmptyLine = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (
    firstNonEmptyLine &&
    firstNonEmptyLine.startsWith('{') &&
    firstNonEmptyLine.endsWith('}')
  ) {
    try {
      const parsed = JSON.parse(firstNonEmptyLine);
      if (
        parsed &&
        typeof parsed === 'object' &&
        ('chunk_id' in parsed ||
          'citation_pill' in parsed ||
          'quote_snippet' in parsed ||
          ('speaker' in parsed && 'text' in parsed))
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Parses a JSONL corpus string line-by-line, validates required fields with exact line-number
 * error reporting ("Import failed on line X: [reason]"), and bulk-inserts all mapped
 * `sources` and `chunks` records into Dexie `EvidenceVaultDB`.
 */
export async function importCorpusFromJsonl(
  rawContent: string,
  fallbackFileName = 'imported-corpus.jsonl'
): Promise<JsonlImportResult> {
  const rawLines = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const chunksToInsert: EvidenceChunk[] = [];
  const sourceAccumulator = new Map<
    string,
    {
      source_id: string;
      title: string;
      source_type: SourceType;
      default_speaker: string;
      file_name: string;
      chunk_count: number;
    }
  >();
  const warnings: string[] = [];

  const defaultSourceTitle =
    fallbackFileName
      .replace(/\.[^/.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || 'Imported JSONL Corpus';
  const defaultSourceId = `src_${defaultSourceTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 24)}`;

  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const trimmed = rawLines[i].trim();
    if (!trimmed) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err: unknown) {
      const reason =
        err instanceof Error ? err.message : 'Invalid JSON syntax';
      const errorMsg = `Import failed on line ${lineNumber}: ${reason}`;
      console.warn(errorMsg, { line: trimmed });
      throw new Error(errorMsg);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const errorMsg = `Import failed on line ${lineNumber}: Expected a JSON object`;
      console.warn(errorMsg, { line: trimmed });
      throw new Error(errorMsg);
    }

    // Extract and validate required text / quote content
    const rawText =
      typeof parsed.text === 'string' && parsed.text.trim()
        ? parsed.text.trim()
        : typeof parsed.quote_snippet === 'string' && parsed.quote_snippet.trim()
        ? parsed.quote_snippet.trim()
        : typeof parsed.quote === 'string' && parsed.quote.trim()
        ? parsed.quote.trim()
        : '';

    if (!rawText) {
      const errorMsg = `Import failed on line ${lineNumber}: Missing required "text" or "quote_snippet" key`;
      console.warn(errorMsg, parsed);
      throw new Error(errorMsg);
    }

    const speaker =
      typeof parsed.speaker === 'string' && parsed.speaker.trim()
        ? parsed.speaker.trim()
        : typeof parsed.default_speaker === 'string' &&
          parsed.default_speaker.trim()
        ? parsed.default_speaker.trim()
        : '';

    if (!speaker) {
      const errorMsg = `Import failed on line ${lineNumber}: Missing required "speaker" key`;
      console.warn(errorMsg, parsed);
      throw new Error(errorMsg);
    }

    const coordinate =
      typeof parsed.coordinate === 'string' && parsed.coordinate.trim()
        ? parsed.coordinate.trim()
        : typeof parsed.timestamp === 'string' && parsed.timestamp.trim()
        ? parsed.timestamp.trim()
        : typeof parsed.page_or_section === 'string' &&
          parsed.page_or_section.trim()
        ? parsed.page_or_section.trim()
        : '';

    if (!coordinate) {
      const errorMsg = `Import failed on line ${lineNumber}: Missing required "coordinate" or "timestamp" key`;
      console.warn(errorMsg, parsed);
      throw new Error(errorMsg);
    }

    const sourceId =
      typeof parsed.source_id === 'string' && parsed.source_id.trim()
        ? parsed.source_id.trim()
        : defaultSourceId;

    const sourceTitle =
      typeof parsed.source_title === 'string' && parsed.source_title.trim()
        ? parsed.source_title.trim()
        : typeof parsed.source === 'string' && parsed.source.trim()
        ? parsed.source.trim()
        : defaultSourceTitle;

    const rawSourceType =
      typeof parsed.source_type === 'string' ? parsed.source_type.trim() : '';
    const sourceType: SourceType = VALID_SOURCE_TYPES.has(
      rawSourceType as SourceType
    )
      ? (rawSourceType as SourceType)
      : 'archival_audio';

    const chunkId =
      typeof parsed.chunk_id === 'string' && parsed.chunk_id.trim()
        ? parsed.chunk_id.trim()
        : `chk_${sourceId}_${String(chunksToInsert.length + 1).padStart(3, '0')}`;

    const rawClassification =
      typeof parsed.classification === 'string'
        ? parsed.classification.trim()
        : '';
    const classification: ClassificationType = VALID_CLASSIFICATIONS.has(
      rawClassification as ClassificationType
    )
      ? (rawClassification as ClassificationType)
      : 'spoken_statement';

    const candidateSnippet =
      typeof parsed.quote_snippet === 'string' && parsed.quote_snippet.trim()
        ? parsed.quote_snippet.trim()
        : rawText;

    const { quote_snippet, citation_pill: generatedPill } = buildCitationPill(
      speaker,
      coordinate,
      rawText,
      candidateSnippet
    );

    const citation_pill =
      typeof parsed.citation_pill === 'string' &&
      parsed.citation_pill.trim().startsWith('[') &&
      parsed.citation_pill.trim().endsWith(']')
        ? parsed.citation_pill.trim()
        : generatedPill;

    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : `${speaker} (${coordinate}): ${rawText.slice(0, 130)}`;

    const named_entities = Array.isArray(parsed.named_entities)
      ? parsed.named_entities
          .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
          .map((e) => e.trim())
      : [speaker];

    const start_ms =
      typeof parsed.start_ms === 'number' && Number.isFinite(parsed.start_ms)
        ? parsed.start_ms
        : null;
    const end_ms =
      typeof parsed.end_ms === 'number' && Number.isFinite(parsed.end_ms)
        ? parsed.end_ms
        : null;
    const page_or_section =
      typeof parsed.page_or_section === 'string' && parsed.page_or_section.trim()
        ? parsed.page_or_section.trim()
        : coordinate;

    chunksToInsert.push({
      chunk_id: chunkId,
      source_id: sourceId,
      source_title: sourceTitle,
      source_type: sourceType,
      speaker,
      coordinate,
      start_ms,
      end_ms,
      page_or_section,
      text: rawText,
      quote_snippet,
      citation_pill,
      classification,
      summary,
      named_entities,
      is_sample: false,
    });

    const existingSource = sourceAccumulator.get(sourceId);
    if (existingSource) {
      existingSource.chunk_count += 1;
    } else {
      sourceAccumulator.set(sourceId, {
        source_id: sourceId,
        title: sourceTitle,
        source_type: sourceType,
        default_speaker: speaker,
        file_name: fallbackFileName,
        chunk_count: 1,
      });
    }
  }

  if (chunksToInsert.length === 0) {
    const errorMsg = 'Import failed on line 1: File contains no valid JSONL lines';
    console.warn(errorMsg);
    throw new Error(errorMsg);
  }

  const nowIso = new Date().toISOString();
  const sourcesToInsert: SourceDocument[] = Array.from(
    sourceAccumulator.values()
  ).map((src) => ({
    ...src,
    ingested_at: nowIso,
    is_sample: false,
  }));

  await db.transaction('rw', db.sources, db.chunks, async () => {
    await db.chunks.bulkPut(chunksToInsert);
    // Recalculate exact chunk_count per affected source in Dexie so re-imports stay accurate
    for (const src of sourcesToInsert) {
      const exactCount = await db.chunks
        .where('source_id')
        .equals(src.source_id)
        .count();
      await db.sources.put({
        ...src,
        chunk_count: exactCount,
      });
    }
  });

  return {
    importedChunksCount: chunksToInsert.length,
    importedSourcesCount: sourcesToInsert.length,
    firstSourceId: sourcesToInsert[0]?.source_id || null,
    warnings,
  };
}

function triggerFileDownload(
  content: string,
  fileName: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Builds the JSONL corpus string directly from the Dexie `chunks` table.
 */
export async function buildCorpusJsonlString(): Promise<{
  fileName: string;
  content: string;
}> {
  const chunks = await db.chunks.toArray();
  const lines = chunks.map((chunk) =>
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
      text: chunk.text,
    })
  );

  const dateStamp = new Date().toISOString().slice(0, 10);
  return {
    fileName: `evidence-vault-corpus-${dateStamp}.jsonl`,
    content: lines.join('\n') + '\n',
  };
}

/**
 * Exports all active EvidenceChunk records directly from the Dexie `chunks` table
 * as newline-delimited JSON (.jsonl) for downstream documentary timeline pipelines.
 */
export async function exportCorpusAsJsonl(): Promise<void> {
  const { fileName, content } = await buildCorpusJsonlString();
  triggerFileDownload(
    content,
    fileName,
    'application/x-jsonlines;charset=utf-8'
  );
}

const CLASSIFICATION_SECTIONS: {
  key: ClassificationType;
  heading: string;
  subtitle: string;
}[] = [
  {
    key: 'verified_record',
    heading: '1. Verified Records & Documentary Proof',
    subtitle:
      'Court filings, certified audits, metered telemetry, and corroborated primary records.',
  },
  {
    key: 'allegation_or_claim',
    heading: '2. Unproven Allegations & Contested Claims',
    subtitle:
      'Disputed assertions, whistleblower accusations, and uncorroborated claims requiring counter-evidence.',
  },
  {
    key: 'spoken_statement',
    heading: '3. Spoken Statements & Witness Testimony',
    subtitle:
      'Direct interview segments, broadcast dialogue, and technical explanations.',
  },
  {
    key: 'editorial_note',
    heading: '4. Editorial & Production Notes',
    subtitle:
      'Internal timeline assembly cues, structural juxtaposition beats, and legal clearance checks.',
  },
];

/**
 * Builds the Verified Evidence Map Markdown string directly from Dexie `sources` and `chunks` tables.
 */
export async function buildEvidenceMapMarkdownString(): Promise<{
  fileName: string;
  content: string;
}> {
  const [sources, chunks] = await Promise.all([
    db.sources.toArray(),
    db.chunks.toArray(),
  ]);

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines: string[] = [
    '# Evidence Vault — Verified Evidence Map',
    '',
    `Generated: ${now} · Sources: ${sources.length} · Total Chunks: ${chunks.length}`,
    '',
    '## Source Catalog',
    '',
  ];

  for (const src of sources) {
    lines.push(
      `- **${src.title}** (\`${src.source_type}\`) — Default Speaker/Ref: ${src.default_speaker} · ${src.chunk_count} chunks · File: \`${src.file_name}\``
    );
  }

  lines.push('');

  for (const section of CLASSIFICATION_SECTIONS) {
    const matching = chunks.filter((c) => c.classification === section.key);
    lines.push(`## ${section.heading} (${matching.length})`);
    lines.push(`_${section.subtitle}_`);
    lines.push('');

    if (matching.length === 0) {
      lines.push('- _No evidence chunks currently classified in this category._');
      lines.push('');
      continue;
    }

    for (const chunk of matching) {
      const entitiesStr =
        chunk.named_entities.length > 0
          ? ` · Entities: ${chunk.named_entities.join(', ')}`
          : '';
      lines.push(`- \`${chunk.citation_pill}\``);
      lines.push(`  - **Analytical Summary**: ${chunk.summary}`);
      lines.push(
        `  - **Provenance**: ${chunk.source_title} (${chunk.page_or_section || chunk.coordinate} · ID: \`${chunk.chunk_id}\`)${entitiesStr}`
      );
      lines.push(`  - **Verbatim Excerpt**: "${chunk.text}"`);
      lines.push('');
    }
  }

  const dateStamp = new Date().toISOString().slice(0, 10);
  return {
    fileName: `verified-evidence-map-${dateStamp}.md`,
    content: lines.join('\n'),
  };
}

/**
 * Exports a clean Markdown briefing reading directly from the Dexie `sources` and `chunks` tables,
 * contrasting Verified Records against Unproven Allegations, Spoken Statements, and Editorial Notes.
 */
export async function exportEvidenceMapAsMarkdown(): Promise<void> {
  const { fileName, content } = await buildEvidenceMapMarkdownString();
  triggerFileDownload(content, fileName, 'text/markdown;charset=utf-8');
}
